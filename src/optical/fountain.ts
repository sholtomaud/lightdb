/**
 * Luby transform (fountain) coding.
 *
 * The optical channel is one-way: the receiver cannot ask for a retransmission,
 * so there is no useful notion of "frame 7 was dropped". Instead every frame is
 * the XOR of a pseudorandom subset of the payload blocks, and the receiver
 * reconstructs once it has collected any ~5-15% more frames than there are
 * blocks -- in any order, with any subset missing.
 *
 * Sender and receiver never exchange the block selection. Each frame carries a
 * 32-bit seed, and both sides run the identical PRNG and degree distribution to
 * derive the same subset from it.
 */

/** xorshift32. Small, fast, and identical across engines -- which is what matters. */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9; // xorshift32 has a fixed point at zero
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** ln(2), exactly as IEEE-754 double 0x3FE62E42FEFA39EF. */
export const LN2 = 0.6931471805599453;

/** Terms in the atanh series. Fixed so the result cannot vary by platform. */
const LOG_TERMS = 20;

/**
 * Natural log, specified rather than borrowed.
 *
 * `Math.log` has implementation-defined precision -- the spec does not require
 * correct rounding, and JavaScript engines and Swift's libm can disagree in the
 * last ULP. Anywhere that difference crosses a distribution boundary, two
 * implementations pick different block subsets from the same seed and every
 * transfer between them fails while both test suites stay green.
 *
 * So the protocol defines its own. Range reduction by powers of two is exact,
 * and the series uses only IEEE-754 add, subtract, multiply and divide, which
 * *are* correctly rounded and therefore bit-identical on any conforming
 * platform. See spec/PROTOCOL.md.
 */
export function protocolLog(x: number): number {
  if (!Number.isFinite(x) || x <= 0) {
    throw new RangeError(`protocolLog domain error: ${x}`);
  }

  // x = m * 2^e with m in [1, 2). Scaling by two is exact in binary floating
  // point, so this reduction introduces no error at all.
  let exponent = 0;
  let mantissa = x;
  while (mantissa >= 2) {
    mantissa /= 2;
    exponent += 1;
  }
  while (mantissa < 1) {
    mantissa *= 2;
    exponent -= 1;
  }

  // ln(m) = 2 * atanh(z) where z = (m-1)/(m+1), giving |z| < 1/3 so the series
  // is far past converged by LOG_TERMS.
  const z = (mantissa - 1) / (mantissa + 1);
  const zSquared = z * z;

  let term = z;
  let sum = z;
  for (let i = 1; i < LOG_TERMS; i += 1) {
    term *= zSquared;
    sum += term / (2 * i + 1);
  }

  return exponent * LN2 + 2 * sum;
}

/**
 * Robust soliton distribution as cumulative *integer* thresholds over 1..k.
 *
 * Returned as scaled 32-bit values so sampling is an integer comparison
 * against a raw PRNG draw. A float CDF would make the chosen degree hinge on
 * the last bit of a division; this cannot.
 *
 * `c` and `delta` are the standard LT tuning knobs: lower `c` shifts mass
 * toward degree 1 (faster start, more frames overall).
 */
export function solitonThresholds(k: number, c = 0.05, delta = 0.05): Uint32Array {
  const probabilities = new Float64Array(k + 1); // indexed by degree, 0 unused

  // Ideal soliton.
  probabilities[1] = 1 / k;
  for (let i = 2; i <= k; i += 1) {
    probabilities[i] = 1 / (i * (i - 1));
  }

  // Robust component. Math.sqrt is correctly rounded by IEEE-754, so unlike
  // log it is safe to use directly.
  const r = c * protocolLog(k / delta) * Math.sqrt(k);
  const pivot = Math.max(1, Math.floor(k / r));
  for (let i = 1; i < pivot && i <= k; i += 1) {
    probabilities[i] += r / (i * k);
  }
  if (pivot <= k) {
    probabilities[pivot] += (r * protocolLog(r / delta)) / k;
  }

  let total = 0;
  for (let i = 1; i <= k; i += 1) total += probabilities[i];

  const thresholds = new Uint32Array(k + 1);
  let running = 0;
  for (let i = 1; i <= k; i += 1) {
    running += probabilities[i] / total;
    // Math.round of a value in [0, 2^32) is exact; the quantisation is the
    // last floating-point step and everything downstream is integer.
    const scaled = Math.round(running * 0xffffffff);
    thresholds[i] = Math.min(0xffffffff, Math.max(thresholds[i - 1], scaled));
  }
  // Saturate, so no draw can fall past the last degree.
  thresholds[k] = 0xffffffff;

  return thresholds;
}

/** First degree whose cumulative threshold covers the draw. */
export function sampleDegree(rng: () => number, thresholds: Uint32Array): number {
  const u = rng() >>> 0;
  for (let i = 1; i < thresholds.length; i += 1) {
    if (u <= thresholds[i]) return i;
  }
  return thresholds.length - 1;
}

/**
 * The block indices a frame with this seed combines, ascending.
 *
 * Both encoder and decoder call this, in both languages. It must stay
 * bit-for-bit deterministic: see spec/PROTOCOL.md and spec/vectors/.
 *
 * The result is sorted rather than returned in insertion order, so that
 * agreement does not depend on two languages iterating a hash set alike.
 */
export function selectBlocks(
  seed: number,
  numBlocks: number,
  thresholds: Uint32Array
): number[] {
  const rng = makeRng(seed);
  const degree = Math.min(sampleDegree(rng, thresholds), numBlocks);

  const picked = new Set<number>();
  // Bounded so a pathological seed cannot spin forever on a small block count.
  let guard = degree * 64 + 64;
  while (picked.size < degree && guard > 0) {
    // Multiply-shift rather than modulo: no bias toward low indices, and the
    // arithmetic is integer on both sides.
    picked.add(Math.floor((rng() * numBlocks) / 0x100000000));
    guard -= 1;
  }
  // Degenerate fallback: fill sequentially from wherever we got to.
  for (let i = 0; picked.size < degree; i += 1) picked.add(i % numBlocks);

  return [...picked].sort((a, b) => a - b);
}

function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i += 1) target[i] ^= source[i];
}

export class FountainEncoder {
  readonly numBlocks: number;
  readonly blockSize: number;
  readonly totalLength: number;

  private blocks: Uint8Array[];
  private thresholds: Uint32Array;

  constructor(payload: Uint8Array, blockSize: number) {
    if (blockSize < 1) throw new RangeError(`Block size must be positive`);
    if (payload.length === 0) throw new RangeError('Payload is empty');

    this.blockSize = blockSize;
    this.totalLength = payload.length;
    this.numBlocks = Math.ceil(payload.length / blockSize);

    // The final block is zero-padded; totalLength tells the receiver where to cut.
    this.blocks = [];
    for (let i = 0; i < this.numBlocks; i += 1) {
      const block = new Uint8Array(blockSize);
      block.set(payload.subarray(i * blockSize, (i + 1) * blockSize));
      this.blocks.push(block);
    }

    this.thresholds = solitonThresholds(this.numBlocks);
  }

  /** The coded block for this seed. */
  encode(seed: number): Uint8Array {
    const indices = selectBlocks(seed, this.numBlocks, this.thresholds);
    const out = new Uint8Array(this.blockSize);
    for (const index of indices) xorInto(out, this.blocks[index]);
    return out;
  }
}

interface PendingEquation {
  indices: Set<number>;
  data: Uint8Array;
}

export class FountainDecoder {
  readonly numBlocks: number;
  readonly blockSize: number;
  readonly totalLength: number;

  private solved: (Uint8Array | null)[];
  private solvedCount = 0;
  private pending: PendingEquation[] = [];
  private thresholds: Uint32Array;

  framesSeen = 0;

  constructor(numBlocks: number, blockSize: number, totalLength: number) {
    this.numBlocks = numBlocks;
    this.blockSize = blockSize;
    this.totalLength = totalLength;
    this.solved = new Array<Uint8Array | null>(numBlocks).fill(null);
    this.thresholds = solitonThresholds(numBlocks);
  }

  get isComplete(): boolean {
    return this.solvedCount === this.numBlocks;
  }

  /** Fraction of blocks recovered, 0..1. */
  get progress(): number {
    return this.numBlocks === 0 ? 1 : this.solvedCount / this.numBlocks;
  }

  /** Feed one frame. Returns true once the payload is fully recovered. */
  addFrame(seed: number, payload: Uint8Array): boolean {
    this.framesSeen += 1;
    if (this.isComplete) return true;
    if (payload.length !== this.blockSize) return false;

    const equation: PendingEquation = {
      indices: new Set(selectBlocks(seed, this.numBlocks, this.thresholds)),
      data: payload.slice(),
    };

    this.substituteKnown(equation);
    if (equation.indices.size === 0) return this.isComplete; // redundant frame

    if (equation.indices.size > 1) {
      this.pending.push(equation);
      return this.isComplete;
    }

    // Degree one: solve it, then cascade through everything it unblocks.
    const queue: number[] = [];
    this.solve(equation, queue);

    while (queue.length > 0) {
      const justSolved = queue.pop() as number;
      const stillPending: PendingEquation[] = [];

      for (const candidate of this.pending) {
        if (candidate.indices.has(justSolved)) {
          xorInto(candidate.data, this.solved[justSolved] as Uint8Array);
          candidate.indices.delete(justSolved);
        }
        if (candidate.indices.size === 1) {
          this.solve(candidate, queue);
        } else if (candidate.indices.size > 1) {
          stillPending.push(candidate);
        }
        // size 0 means it became redundant; drop it
      }
      this.pending = stillPending;
    }

    return this.isComplete;
  }

  /** The recovered payload, or null if still incomplete. */
  result(): Uint8Array | null {
    if (!this.isComplete) return null;

    const out = new Uint8Array(this.totalLength);
    for (let i = 0; i < this.numBlocks; i += 1) {
      const block = this.solved[i] as Uint8Array;
      const offset = i * this.blockSize;
      const take = Math.min(this.blockSize, this.totalLength - offset);
      if (take > 0) out.set(block.subarray(0, take), offset);
    }
    return out;
  }

  private substituteKnown(equation: PendingEquation): void {
    for (const index of [...equation.indices]) {
      const known = this.solved[index];
      if (known) {
        xorInto(equation.data, known);
        equation.indices.delete(index);
      }
    }
  }

  private solve(equation: PendingEquation, queue: number[]): void {
    const index = equation.indices.values().next().value as number;
    if (this.solved[index]) return;

    this.solved[index] = equation.data;
    this.solvedCount += 1;
    equation.indices.clear();
    queue.push(index);
  }
}
