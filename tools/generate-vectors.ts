/**
 * Regenerates spec/vectors/ from the TypeScript implementation.
 *
 * These files are the contract between the web app and any other
 * implementation. Both suites read them; if the Swift fountain selector
 * disagrees on one seed out of thousands, CI says so -- rather than the two
 * devices staring at each other through a camera lens with no explanation.
 *
 * Run with `make vectors`. Regenerating is a deliberate protocol change: bump
 * PROTOCOL_VERSION in the same commit.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FountainDecoder,
  FountainEncoder,
  makeRng,
  protocolLog,
  selectBlocks,
  solitonThresholds,
} from '../src/optical/fountain.ts';
import {
  PROTOCOL_VERSION,
  crc32,
  encodeFrame,
  type FrameHeader,
} from '../src/optical/frame.ts';
import { toBase64Url } from '../src/optical/base64.ts';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'vectors');

/** Exact bit pattern of a binary64, so conformance is unambiguous. */
function doubleBits(value: number): string {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function write(name: string, data: unknown): void {
  const path = join(OUT_DIR, name);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log(`wrote ${path}`);
}

mkdirSync(OUT_DIR, { recursive: true });

// ------------------------------------------------------------------- prng

write('prng.json', {
  description: 'xorshift32 output. state 0 is remapped to 0x9E3779B9.',
  cases: [0, 1, 2, 42, 1000, 0x9e3779b9, 0xffffffff, 0x7fffffff].map((seed) => {
    const rng = makeRng(seed);
    return { seed, outputs: Array.from({ length: 8 }, () => rng()) };
  }),
});

// -------------------------------------------------------------------- log

write('log.json', {
  description:
    'protocolLog at specified inputs. Values are big-endian binary64 bit patterns.',
  ln2Bits: doubleBits(0.6931471805599453),
  cases: [
    1, 1.5, 2, 3, 10, 100, 1000, 20, 200, 2000, 0.5, 0.1, 0.05,
    1.0000001, 65535, 4294967296, 2.718281828459045,
  ].map((input) => ({
    inputBits: doubleBits(input),
    input,
    outputBits: doubleBits(protocolLog(input)),
  })),
});

// ------------------------------------------------------------- thresholds

write('thresholds.json', {
  description:
    'Robust soliton cumulative thresholds, c=0.05 delta=0.05. Index 0 unused.',
  c: 0.05,
  delta: 0.05,
  cases: [1, 2, 3, 5, 10, 32, 64, 100, 256, 1000].map((k) => ({
    k,
    thresholds: Array.from(solitonThresholds(k)),
  })),
});

// -------------------------------------------------------------- selection

write('selection.json', {
  description:
    'Block indices per seed, ascending. The single most load-bearing vector set.',
  cases: [1, 2, 5, 17, 64, 200, 1000].flatMap((numBlocks) => {
    const thresholds = solitonThresholds(numBlocks);
    // Dense low seeds (what a real stream actually uses) plus edge values.
    const seeds = [
      ...Array.from({ length: 64 }, (_, i) => i + 1),
      255, 256, 65535, 65536, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff,
    ];
    return seeds.map((seed) => ({
      numBlocks,
      seed,
      indices: selectBlocks(seed, numBlocks, thresholds),
    }));
  }),
});

// ------------------------------------------------------------------ crc32

write('crc32.json', {
  description: 'CRC-32 (IEEE 802.3) of UTF-8 encoded strings and byte patterns.',
  cases: [
    { text: '', crc: crc32(new TextEncoder().encode('')) },
    { text: '123456789', crc: crc32(new TextEncoder().encode('123456789')) },
    { text: 'lightdb', crc: crc32(new TextEncoder().encode('lightdb')) },
    { text: 'The quick brown fox', crc: crc32(new TextEncoder().encode('The quick brown fox')) },
  ],
  byteCases: [
    { bytesHex: '', crc: crc32(new Uint8Array(0)) },
    { bytesHex: '00', crc: crc32(new Uint8Array([0])) },
    { bytesHex: 'ff', crc: crc32(new Uint8Array([0xff])) },
    {
      bytesHex: hex(new Uint8Array(256).map((_, i) => i)),
      crc: crc32(new Uint8Array(256).map((_, i) => i)),
    },
  ],
});

// ----------------------------------------------------------------- frames

const frameCases = [
  { blockSize: 8, numBlocks: 1, totalLength: 8, sessionId: 1, seed: 1, flags: 0 },
  { blockSize: 32, numBlocks: 4, totalLength: 100, sessionId: 0xdeadbeef, seed: 42, flags: 0 },
  {
    blockSize: 64,
    numBlocks: 500,
    totalLength: 31999,
    sessionId: 0xffffffff,
    seed: 0xfffffffe,
    flags: 1,
  },
].map((spec) => {
  const payload = new Uint8Array(spec.blockSize).map((_, i) => (i * 7 + 3) & 0xff);
  const header: FrameHeader = {
    protocolVersion: PROTOCOL_VERSION,
    flags: spec.flags,
    sessionId: spec.sessionId,
    totalLength: spec.totalLength,
    blockSize: spec.blockSize,
    numBlocks: spec.numBlocks,
    seed: spec.seed,
    checksum: 0x12345678,
  };
  const encoded = encodeFrame(header, payload);
  return {
    header,
    payloadHex: hex(payload),
    encodedHex: hex(encoded),
    encodedBase64Url: toBase64Url(encoded),
  };
});

write('frames.json', {
  description: 'Header + payload to exact wire bytes, then base64url.',
  protocolVersion: PROTOCOL_VERSION,
  cases: frameCases,
});

// ----------------------------------------------------------------- streams

/**
 * Complete fountain-coded transmissions, exactly as they leave the sender.
 *
 * The strongest vector in the set: another implementation must reassemble the
 * original payload from these frames alone. Every other file checks a single
 * function; this one checks that the whole chain agrees.
 *
 * Frames are deliberately thinned to force real peeling rather than a lucky
 * run of degree-one frames.
 */
const streamCases = [
  { totalLength: 64, blockSize: 16, drop: 0 },
  { totalLength: 1000, blockSize: 64, drop: 3 },
  { totalLength: 8192, blockSize: 128, drop: 4 },
].map(({ totalLength, blockSize, drop }) => {
  const payload = new Uint8Array(totalLength).map((_, i) => (i * 37 + 11) & 0xff);
  const encoder = new FountainEncoder(payload, blockSize);
  const checksum = crc32(payload);

  const header: FrameHeader = {
    protocolVersion: PROTOCOL_VERSION,
    flags: 0,
    sessionId: 0x5eed0000 + totalLength,
    totalLength,
    blockSize,
    numBlocks: encoder.numBlocks,
    seed: 0,
    checksum,
  };

  // Decode alongside, so the vector is only written if it is actually solvable.
  const verifier = new FountainDecoder(encoder.numBlocks, blockSize, totalLength);
  const frames: string[] = [];

  for (let seed = 1; seed <= encoder.numBlocks * 40 + 400; seed += 1) {
    if (drop > 0 && seed % drop === 0) continue;

    const text = toBase64Url(encodeFrame({ ...header, seed }, encoder.encode(seed)));
    frames.push(text);

    if (verifier.addFrame(seed, encoder.encode(seed))) break;
  }

  if (!verifier.isComplete) {
    throw new Error(`stream vector for ${totalLength}B never completed`);
  }

  return {
    totalLength,
    blockSize,
    numBlocks: encoder.numBlocks,
    checksum,
    payloadHex: hex(payload),
    frames,
  };
});

write('streams.json', {
  description:
    'Complete transmissions. An implementation must reassemble payloadHex from frames alone.',
  protocolVersion: PROTOCOL_VERSION,
  cases: streamCases,
});

console.log(`\nprotocol version ${PROTOCOL_VERSION}`);
