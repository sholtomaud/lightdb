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

/**
 * Robust soliton distribution, as a cumulative table over degrees 1..k.
 *
 * `c` and `delta` are the standard LT tuning knobs: lower `c` shifts mass
 * toward degree 1 (faster start, more frames overall).
 */
export function robustSolitonCdf(k: number, c = 0.05, delta = 0.05): Float64Array {
  const probabilities = new Float64Array(k + 1); // index by degree, 0 unused

  // Ideal soliton.
  probabilities[1] = 1 / k;
  for (let i = 2; i <= k; i += 1) {
    probabilities[i] = 1 / (i * (i - 1));
  }

  // Robust component.
  const r = c * Math.log(k / delta) * Math.sqrt(k);
  const pivot = Math.max(1, Math.floor(k / r));
  for (let i = 1; i < pivot; i += 1) {
    probabilities[i] += r / (i * k);
  }
  if (pivot <= k) {
    probabilities[pivot] += (r * Math.log(r / delta)) / k;
  }

  let total = 0;
  for (let i = 1; i <= k; i += 1) total += probabilities[i];

  const cdf = new Float64Array(k + 1);
  let running = 0;
  for (let i = 1; i <= k; i += 1) {
    running += probabilities[i] / total;
    cdf[i] = running;
  }
  cdf[k] = 1;
  return cdf;
}

function sampleDegree(rng: () => number, cdf: Float64Array): number {
  const u = rng() / 0x100000000;
  for (let i = 1; i < cdf.length; i += 1) {
    if (u <= cdf[i]) return i;
  }
  return cdf.length - 1;
}

/**
 * The block indices a frame with this seed combines.
 *
 * Both encoder and decoder call this. It must stay bit-for-bit deterministic.
 */
export function selectBlocks(
  seed: number,
  numBlocks: number,
  cdf: Float64Array
): number[] {
  const rng = makeRng(seed);
  const degree = Math.min(sampleDegree(rng, cdf), numBlocks);

  const picked = new Set<number>();
  // Bounded so a pathological seed cannot spin forever on a small block count.
  let guard = degree * 64 + 64;
  while (picked.size < degree && guard > 0) {
    picked.add(Math.floor((rng() / 0x100000000) * numBlocks));
    guard -= 1;
  }
  // Degenerate fallback: fill sequentially from wherever we got to.
  for (let i = 0; picked.size < degree; i += 1) picked.add(i % numBlocks);

  return [...picked];
}

function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i += 1) target[i] ^= source[i];
}

export class FountainEncoder {
  readonly numBlocks: number;
  readonly blockSize: number;
  readonly totalLength: number;

  private blocks: Uint8Array[];
  private cdf: Float64Array;

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

    this.cdf = robustSolitonCdf(this.numBlocks);
  }

  /** The coded block for this seed. */
  encode(seed: number): Uint8Array {
    const indices = selectBlocks(seed, this.numBlocks, this.cdf);
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
  private cdf: Float64Array;

  framesSeen = 0;

  constructor(numBlocks: number, blockSize: number, totalLength: number) {
    this.numBlocks = numBlocks;
    this.blockSize = blockSize;
    this.totalLength = totalLength;
    this.solved = new Array<Uint8Array | null>(numBlocks).fill(null);
    this.cdf = robustSolitonCdf(numBlocks);
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
      indices: new Set(selectBlocks(seed, this.numBlocks, this.cdf)),
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
