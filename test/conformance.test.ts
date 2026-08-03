/**
 * Conformance against spec/vectors/.
 *
 * These are the same files the Swift suite reads. On this side they are a
 * regression guard: if a refactor changes what a seed selects, this fails
 * rather than silently breaking interop with every other implementation.
 *
 * Regenerating the vectors to make this pass is a protocol change, not a fix.
 * Bump PROTOCOL_VERSION in the same commit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FountainDecoder,
  makeRng,
  protocolLog,
  selectBlocks,
  solitonThresholds,
} from '../src/optical/fountain.ts';
import {
  PROTOCOL_VERSION,
  crc32,
  decodeFrame,
  encodeFrame,
} from '../src/optical/frame.ts';
import { fromBase64Url, toBase64Url } from '../src/optical/base64.ts';

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'vectors');

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(VECTORS, name), 'utf8')) as T;
}

function doubleBits(value: number): string {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

test('PRNG matches the conformance vectors', () => {
  const { cases } = load<{ cases: { seed: number; outputs: number[] }[] }>('prng.json');
  assert.ok(cases.length > 0);

  for (const { seed, outputs } of cases) {
    const rng = makeRng(seed);
    const actual = outputs.map(() => rng());
    assert.deepEqual(actual, outputs, `seed ${seed}`);
  }
});

test('protocolLog matches the conformance vectors bit for bit', () => {
  const { cases } = load<{
    cases: { input: number; inputBits: string; outputBits: string }[];
  }>('log.json');
  assert.ok(cases.length > 0);

  for (const { input, inputBits, outputBits } of cases) {
    assert.equal(doubleBits(input), inputBits, `input ${input} is not the stored double`);
    assert.equal(
      doubleBits(protocolLog(input)),
      outputBits,
      `protocolLog(${input}) differs from the vector`
    );
  }
});

test('soliton thresholds match the conformance vectors', () => {
  const { cases } = load<{ cases: { k: number; thresholds: number[] }[] }>(
    'thresholds.json'
  );
  assert.ok(cases.length > 0);

  for (const { k, thresholds } of cases) {
    assert.deepEqual(Array.from(solitonThresholds(k)), thresholds, `k=${k}`);
  }
});

test('block selection matches the conformance vectors', () => {
  const { cases } = load<{
    cases: { numBlocks: number; seed: number; indices: number[] }[];
  }>('selection.json');
  assert.ok(cases.length > 100, 'expected a dense selection vector set');

  // Cache tables so the assertion cost is the comparison, not construction.
  const tables = new Map<number, Uint32Array>();

  for (const { numBlocks, seed, indices } of cases) {
    let thresholds = tables.get(numBlocks);
    if (!thresholds) {
      thresholds = solitonThresholds(numBlocks);
      tables.set(numBlocks, thresholds);
    }

    assert.deepEqual(
      selectBlocks(seed, numBlocks, thresholds),
      indices,
      `numBlocks=${numBlocks} seed=${seed}`
    );
  }
});

test('CRC-32 matches the conformance vectors', () => {
  const vectors = load<{
    cases: { text: string; crc: number }[];
    byteCases: { bytesHex: string; crc: number }[];
  }>('crc32.json');

  for (const { text, crc } of vectors.cases) {
    assert.equal(crc32(new TextEncoder().encode(text)), crc, `text ${JSON.stringify(text)}`);
  }

  for (const { bytesHex, crc } of vectors.byteCases) {
    const bytes = new Uint8Array(
      (bytesHex.match(/../g) ?? []).map((pair) => parseInt(pair, 16))
    );
    assert.equal(crc32(bytes), crc, `bytes ${bytesHex.slice(0, 16)}…`);
  }
});

test('recorded streams reassemble to their original payload', () => {
  const vectors = load<{
    cases: {
      totalLength: number;
      blockSize: number;
      numBlocks: number;
      checksum: number;
      payloadHex: string;
      frames: string[];
    }[];
  }>('streams.json');

  for (const streamCase of vectors.cases) {
    const decoder = new FountainDecoder(
      streamCase.numBlocks,
      streamCase.blockSize,
      streamCase.totalLength
    );

    let complete = false;
    for (const text of streamCase.frames) {
      const bytes = fromBase64Url(text);
      assert.notEqual(bytes, null, 'frame failed base64url decode');

      const frame = decodeFrame(bytes as Uint8Array);
      assert.notEqual(frame, null, 'frame failed to parse');
      if (!frame) break;

      complete = decoder.addFrame(frame.header.seed, frame.payload);
      if (complete) break;
    }

    assert.ok(complete, `${streamCase.totalLength}B stream never completed`);

    const payload = decoder.result() as Uint8Array;
    assert.equal(hex(payload), streamCase.payloadHex, 'payload mismatch');
    assert.equal(crc32(payload), streamCase.checksum, 'checksum mismatch');
  }
});

test('frame encoding matches the conformance vectors', () => {
  const vectors = load<{
    protocolVersion: number;
    cases: {
      header: Parameters<typeof encodeFrame>[0];
      payloadHex: string;
      encodedHex: string;
      encodedBase64Url: string;
    }[];
  }>('frames.json');

  assert.equal(
    vectors.protocolVersion,
    PROTOCOL_VERSION,
    'vectors are stale: regenerate with `make vectors`'
  );

  for (const { header, payloadHex, encodedHex, encodedBase64Url } of vectors.cases) {
    const payload = new Uint8Array(
      (payloadHex.match(/../g) ?? []).map((pair) => parseInt(pair, 16))
    );
    const encoded = encodeFrame(header, payload);

    assert.equal(hex(encoded), encodedHex, `session ${header.sessionId}`);
    assert.equal(toBase64Url(encoded), encodedBase64Url, `session ${header.sessionId}`);
  }
});
