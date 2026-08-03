/**
 * Minimal QR Code generator: byte mode only, versions 1-40, all four ECC levels.
 *
 * Byte mode is the only mode we need -- every payload we transmit is a binary
 * fountain frame, never text or digits. Dropping the numeric/alphanumeric/kanji
 * modes and the ECI machinery removes most of a general-purpose QR library.
 *
 * The block-structure tables are the two irreducible ones (EC codewords per
 * block, and block count). Everything else -- total capacity, block splits,
 * alignment positions, format bits, version bits -- is computed. See
 * test/qr-encode.test.ts, which re-derives the published capacity figures from
 * these tables so a typo cannot pass silently.
 */

import { rsDivisor, rsRemainder } from './galois.ts';

export type EccLevel = 'L' | 'M' | 'Q' | 'H';

export const ECC_LEVELS: readonly EccLevel[] = ['L', 'M', 'Q', 'H'];

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

/** Format-info value for each ECC level (not the same order as the name). */
const FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** Index 0 is unused so the array can be indexed directly by version number. */
const ECC_CODEWORDS_PER_BLOCK: Record<EccLevel, readonly number[]> = {
  // prettier-ignore
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  // prettier-ignore
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  // prettier-ignore
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  // prettier-ignore
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

const NUM_ERROR_CORRECTION_BLOCKS: Record<EccLevel, readonly number[]> = {
  // prettier-ignore
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  // prettier-ignore
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  // prettier-ignore
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  // prettier-ignore
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** The 1:1:3:1:1 finder ratio plus four light modules, as a bit pattern. */
const FINDER_LIKE = [true, false, true, true, true, false, true, false, false, false, false];

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

function assertVersion(version: number): void {
  if (
    !Number.isInteger(version) ||
    version < MIN_VERSION ||
    version > MAX_VERSION
  ) {
    throw new RangeError(`QR version out of range: ${version}`);
  }
}

/**
 * Data + EC modules available at this version, before block structuring.
 * Total modules minus finders, timing, alignment, format and version areas.
 */
export function numRawDataModules(version: number): number {
  assertVersion(version);
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Total codewords (data + error correction) at this version. */
export function numTotalCodewords(version: number): number {
  return Math.floor(numRawDataModules(version) / 8);
}

/** Codewords available for payload after error correction is reserved. */
export function numDataCodewords(version: number, ecc: EccLevel): number {
  return (
    numTotalCodewords(version) -
    ECC_CODEWORDS_PER_BLOCK[ecc][version] * NUM_ERROR_CORRECTION_BLOCKS[ecc][version]
  );
}

/** Bits the character-count field occupies in byte mode. */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Maximum payload bytes encodable at this version and ECC level. */
export function byteCapacity(version: number, ecc: EccLevel): number {
  const availableBits = numDataCodewords(version, ecc) * 8 - 4 - charCountBits(version);
  return Math.max(0, Math.floor(availableBits / 8));
}

/** Centre coordinates of the alignment patterns, ascending. */
export function alignmentPatternPositions(version: number): number[] {
  assertVersion(version);
  if (version === 1) return [];

  const numAlign = Math.floor(version / 7) + 2;
  // Version 32 is the one case the general spacing rule does not reproduce.
  const step =
    version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;

  const result = [6];
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

/**
 * Smallest version that fits `byteLength` at this ECC level, or null.
 */
export function smallestVersion(
  byteLength: number,
  ecc: EccLevel,
  minVersion = MIN_VERSION,
  maxVersion = MAX_VERSION
): number | null {
  for (let v = Math.max(MIN_VERSION, minVersion); v <= Math.min(MAX_VERSION, maxVersion); v += 1) {
    if (byteCapacity(v, ecc) >= byteLength) return v;
  }
  return null;
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) {
    bits.push((value >>> i) & 1);
  }
}

/** Byte-mode segment, terminator and padding, as a full codeword block. */
function buildDataCodewords(
  data: Uint8Array,
  version: number,
  ecc: EccLevel
): Uint8Array {
  const capacityBits = numDataCodewords(version, ecc) * 8;
  const bits: number[] = [];

  appendBits(bits, 0b0100, 4); // byte mode
  appendBits(bits, data.length, charCountBits(version));
  for (const b of data) appendBits(bits, b, 8);

  if (bits.length > capacityBits) {
    throw new RangeError(
      `Payload of ${data.length} bytes exceeds version ${version}-${ecc} capacity`
    );
  }

  appendBits(bits, 0, Math.min(4, capacityBits - bits.length)); // terminator
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8); // byte align

  for (let padByte = 0xec; bits.length < capacityBits; padByte ^= 0xec ^ 0x11) {
    appendBits(bits, padByte, 8);
  }

  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i += 1) {
    out[i >>> 3] |= bits[i] << (7 - (i & 7));
  }
  return out;
}

export interface EncodeOptions {
  ecc?: EccLevel;
  /** Pin the version so every frame in a stream is identical in size. */
  version?: number;
  minVersion?: number;
  maxVersion?: number;
  /** 0-7, or -1 to pick the lowest-penalty mask. Pinning skips 8 scoring passes. */
  mask?: number;
}

export class QrCode {
  readonly version: number;
  readonly ecc: EccLevel;
  readonly size: number;
  readonly mask: number;

  private modules: boolean[][];
  private isFunction: boolean[][];

  private constructor(
    version: number,
    ecc: EccLevel,
    dataCodewords: Uint8Array,
    mask: number
  ) {
    assertVersion(version);
    if (mask < -1 || mask > 7) throw new RangeError(`Mask out of range: ${mask}`);

    this.version = version;
    this.ecc = ecc;
    this.size = version * 4 + 17;

    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false)
    );
    this.isFunction = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false)
    );

    this.drawFunctionPatterns();
    this.drawCodewords(this.addEccAndInterleave(dataCodewords));
    this.mask = this.selectAndApplyMask(mask);
  }

  /** Encode arbitrary bytes. Throws if the payload does not fit. */
  static encodeBytes(data: Uint8Array, options: EncodeOptions = {}): QrCode {
    const ecc = options.ecc ?? 'L';
    const mask = options.mask ?? -1;

    let version: number;
    if (options.version !== undefined) {
      assertVersion(options.version);
      if (byteCapacity(options.version, ecc) < data.length) {
        throw new RangeError(
          `Payload of ${data.length} bytes exceeds version ${options.version}-${ecc} ` +
            `capacity of ${byteCapacity(options.version, ecc)}`
        );
      }
      version = options.version;
    } else {
      const found = smallestVersion(
        data.length,
        ecc,
        options.minVersion ?? MIN_VERSION,
        options.maxVersion ?? MAX_VERSION
      );
      if (found === null) {
        throw new RangeError(`Payload of ${data.length} bytes does not fit any version`);
      }
      version = found;
    }

    return new QrCode(version, ecc, buildDataCodewords(data, version, ecc), mask);
  }

  /** True when the module at (x, y) is dark. Out-of-range reads are light. */
  getModule(x: number, y: number): boolean {
    return (
      x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x]
    );
  }

  /** Row-major copy of the module grid. */
  toBooleanGrid(): boolean[][] {
    return this.modules.map((row) => row.slice());
  }

  // ---------------------------------------------------------------- patterns

  private setFunctionModule(x: number, y: number, isDark: boolean): void {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i += 1) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }

    // Finders, drawn 9x9 so the separators come along for free.
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);

    const positions = alignmentPatternPositions(this.version);
    const n = positions.length;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const isFinderCorner =
          (i === 0 && j === 0) ||
          (i === 0 && j === n - 1) ||
          (i === n - 1 && j === 0);
        if (!isFinderCorner) {
          this.drawAlignmentPattern(positions[i], positions[j]);
        }
      }
    }

    // Reserve the format/version areas. Real format bits land after masking.
    this.drawFormatBits(0);
    this.drawVersionBits();
  }

  private drawFinderPattern(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignmentPattern(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.setFunctionModule(
          x + dx,
          y + dy,
          Math.max(Math.abs(dx), Math.abs(dy)) !== 1
        );
      }
    }
  }

  /** 15-bit format info: 5 data bits + BCH(15,5), masked with 0x5412. */
  private drawFormatBits(mask: number): void {
    const data = (FORMAT_BITS[this.ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i += 1) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const bits = ((data << 10) | rem) ^ 0x5412;

    // Copy 1, around the top-left finder.
    for (let i = 0; i <= 5; i += 1) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i += 1) {
      this.setFunctionModule(14 - i, 8, getBit(bits, i));
    }

    // Copy 2, split between the other two finders.
    for (let i = 0; i < 8; i += 1) {
      this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
    }
    for (let i = 8; i < 15; i += 1) {
      this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
    }
    this.setFunctionModule(8, this.size - 8, true); // always-dark module
  }

  /** 18-bit version info: 6 data bits + BCH(18,6). Version 7 and up only. */
  private drawVersionBits(): void {
    if (this.version < 7) return;

    let rem = this.version;
    for (let i = 0; i < 12; i += 1) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const bits = (this.version << 12) | rem;

    for (let i = 0; i < 18; i += 1) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  }

  // ------------------------------------------------------------- codewords

  /**
   * Split data into blocks, append Reed-Solomon to each, and interleave.
   *
   * Short blocks carry a one-byte padding slot between data and EC so every
   * block has the same length; the interleaver skips that slot.
   */
  private addEccAndInterleave(data: Uint8Array): Uint8Array {
    const expected = numDataCodewords(this.version, this.ecc);
    if (data.length !== expected) {
      throw new RangeError(`Expected ${expected} data codewords, got ${data.length}`);
    }

    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[this.ecc][this.version];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[this.ecc][this.version];
    const rawCodewords = numTotalCodewords(this.version);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const divisor = rsDivisor(blockEccLen);
    const blocks: Uint8Array[] = [];

    for (let i = 0, k = 0; i < numBlocks; i += 1) {
      const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      const dat = data.subarray(k, k + datLen);
      k += datLen;

      const block = new Uint8Array(shortBlockLen + 1);
      block.set(dat, 0);
      block.set(rsRemainder(dat, divisor), shortBlockLen + 1 - blockEccLen);
      blocks.push(block);
    }

    const result = new Uint8Array(rawCodewords);
    let idx = 0;
    for (let i = 0; i <= shortBlockLen; i += 1) {
      for (let j = 0; j < blocks.length; j += 1) {
        const isPaddingSlot = i === shortBlockLen - blockEccLen && j < numShortBlocks;
        if (!isPaddingSlot) {
          result[idx] = blocks[j][i];
          idx += 1;
        }
      }
    }
    return result;
  }

  /** Zigzag fill, two columns at a time, right to left, skipping column 6. */
  private drawCodewords(data: Uint8Array): void {
    let i = 0;
    const totalBits = data.length * 8;

    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < totalBits) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i += 1;
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ mask

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.isFunction[y][x]) continue;

        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: throw new RangeError(`Mask out of range: ${mask}`);
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  private selectAndApplyMask(mask: number): number {
    let chosen = mask;

    if (chosen === -1) {
      let minPenalty = Infinity;
      for (let i = 0; i < 8; i += 1) {
        this.applyMask(i);
        this.drawFormatBits(i);
        const penalty = this.penaltyScore();
        if (penalty < minPenalty) {
          chosen = i;
          minPenalty = penalty;
        }
        this.applyMask(i); // XOR is its own inverse
      }
    }

    this.applyMask(chosen);
    this.drawFormatBits(chosen);
    return chosen;
  }

  /** The four penalty rules from the spec. Lower is better. */
  private penaltyScore(): number {
    let result = 0;
    const size = this.size;

    // Rule 1: runs of five or more same-coloured modules.
    for (let i = 0; i < size; i += 1) {
      result += this.runPenalty((k) => this.modules[i][k], size);
      result += this.runPenalty((k) => this.modules[k][i], size);
    }

    // Rule 2: 2x2 blocks of one colour.
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const c = this.modules[y][x];
        if (
          c === this.modules[y][x + 1] &&
          c === this.modules[y + 1][x] &&
          c === this.modules[y + 1][x + 1]
        ) {
          result += PENALTY_N2;
        }
      }
    }

    // Rule 3: finder-like 1:1:3:1:1 patterns with a light run beside them.
    for (let i = 0; i < size; i += 1) {
      result += this.finderLikePenalty((k) => this.modules[i][k], size);
      result += this.finderLikePenalty((k) => this.modules[k][i], size);
    }

    // Rule 4: deviation of dark module proportion from 50%.
    let dark = 0;
    for (const row of this.modules) {
      for (const c of row) if (c) dark += 1;
    }
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;

    return result;
  }

  private runPenalty(at: (i: number) => boolean, length: number): number {
    let penalty = 0;
    let runColor = at(0);
    let runLength = 0;

    for (let i = 0; i < length; i += 1) {
      if (at(i) === runColor) {
        runLength += 1;
        if (runLength === 5) penalty += PENALTY_N1;
        else if (runLength > 5) penalty += 1;
      } else {
        runColor = at(i);
        runLength = 1;
      }
    }
    return penalty;
  }

  private finderLikePenalty(at: (i: number) => boolean, length: number): number {
    let penalty = 0;
    const n = FINDER_LIKE.length;

    for (let i = 0; i + n <= length; i += 1) {
      let forward = true;
      let backward = true;
      for (let j = 0; j < n; j += 1) {
        if (at(i + j) !== FINDER_LIKE[j]) forward = false;
        if (at(i + j) !== FINDER_LIKE[n - 1 - j]) backward = false;
      }
      if (forward) penalty += PENALTY_N3;
      if (backward) penalty += PENALTY_N3;
    }
    return penalty;
  }
}
