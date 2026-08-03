import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FountainDecoder,
  FountainEncoder,
  makeRng,
  solitonThresholds,
  selectBlocks,
} from '../src/optical/fountain.ts';

function payloadOf(length: number, salt = 1): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 31 + salt * 17) & 0xff;
  }
  return bytes;
}

function transfer(
  payload: Uint8Array,
  blockSize: number,
  options: { drop?: (seed: number) => boolean; shuffle?: boolean; maxFrames?: number } = {}
): { decoder: FountainDecoder; framesSent: number } {
  const encoder = new FountainEncoder(payload, blockSize);
  const decoder = new FountainDecoder(encoder.numBlocks, blockSize, payload.length);

  const maxFrames = options.maxFrames ?? encoder.numBlocks * 40 + 400;
  const queue: [number, Uint8Array][] = [];
  let framesSent = 0;

  for (let seed = 1; seed <= maxFrames && !decoder.isComplete; seed += 1) {
    framesSent += 1;
    if (options.drop?.(seed)) continue;

    queue.push([seed, encoder.encode(seed)]);

    // Deliver in small out-of-order batches to mimic a camera catching up.
    if (!options.shuffle || queue.length >= 5) {
      if (options.shuffle) queue.reverse();
      for (const [s, block] of queue) decoder.addFrame(s, block);
      queue.length = 0;
    }
  }
  for (const [s, block] of queue) decoder.addFrame(s, block);

  return { decoder, framesSent };
}

test('xorshift32 is deterministic and never sticks at zero', () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  for (let i = 0; i < 100; i += 1) {
    assert.equal(a(), b(), `diverged at draw ${i}`);
  }

  // Seed 0 is a fixed point of raw xorshift32; the constructor must handle it.
  const zero = makeRng(0);
  const first = zero();
  assert.notEqual(first, 0);
  assert.notEqual(zero(), first);
});

test('the soliton distribution is a valid cumulative table', () => {
  for (const k of [1, 2, 10, 100, 1000]) {
    const thresholds = solitonThresholds(k);
    assert.equal(thresholds.length, k + 1);
    assert.equal(thresholds[k], 0xffffffff, `k=${k} does not saturate`);

    for (let i = 2; i <= k; i += 1) {
      assert.ok(thresholds[i] >= thresholds[i - 1], `k=${k} not monotonic at ${i}`);
    }
  }
});

test('block selection is deterministic and within range', () => {
  const numBlocks = 40;
  const thresholds = solitonThresholds(numBlocks);

  for (let seed = 1; seed < 200; seed += 1) {
    const first = selectBlocks(seed, numBlocks, thresholds);
    const second = selectBlocks(seed, numBlocks, thresholds);

    assert.deepEqual(first, second, `seed ${seed} is not reproducible`);
    assert.ok(first.length >= 1 && first.length <= numBlocks);
    assert.equal(new Set(first).size, first.length, `seed ${seed} repeated a block`);

    for (const index of first) {
      assert.ok(index >= 0 && index < numBlocks, `seed ${seed} selected ${index}`);
    }
  }
});

test('a clean channel recovers the payload exactly', () => {
  for (const [length, blockSize] of [
    [1, 8],
    [64, 8],
    [500, 64],
    [4096, 128],
  ] as [number, number][]) {
    const payload = payloadOf(length);
    const { decoder } = transfer(payload, blockSize);

    assert.ok(decoder.isComplete, `${length}B/${blockSize}B did not complete`);
    assert.deepEqual(decoder.result(), payload, `${length}B/${blockSize}B mismatch`);
  }
});

test('a payload that is not a multiple of the block size is trimmed correctly', () => {
  const payload = payloadOf(1001);
  const { decoder } = transfer(payload, 64);

  assert.ok(decoder.isComplete);
  assert.equal(decoder.result()?.length, 1001);
  assert.deepEqual(decoder.result(), payload);
});

test('heavy frame loss only costs time, not correctness', () => {
  const payload = payloadOf(2048);
  // Drop two of every three frames.
  const { decoder } = transfer(payload, 64, { drop: (seed) => seed % 3 !== 0 });

  assert.ok(decoder.isComplete, 'did not recover under 66% loss');
  assert.deepEqual(decoder.result(), payload);
});

test('out-of-order and duplicated frames are harmless', () => {
  const payload = payloadOf(1500);
  const encoder = new FountainEncoder(payload, 64);
  const decoder = new FountainDecoder(encoder.numBlocks, 64, payload.length);

  const frames: [number, Uint8Array][] = [];
  for (let seed = 1; seed <= encoder.numBlocks * 8; seed += 1) {
    frames.push([seed, encoder.encode(seed)]);
  }

  // Reverse order, and feed everything twice.
  frames.reverse();
  for (const [seed, block] of frames) decoder.addFrame(seed, block);
  for (const [seed, block] of frames) decoder.addFrame(seed, block);

  assert.ok(decoder.isComplete);
  assert.deepEqual(decoder.result(), payload);
});

test('overhead stays within a sane multiple of the block count', () => {
  const payload = payloadOf(8192);
  const { decoder, framesSent } = transfer(payload, 128);

  assert.ok(decoder.isComplete);
  // LT codes need a modest excess; anything past 3x means the distribution is wrong.
  assert.ok(
    framesSent < decoder.numBlocks * 3,
    `needed ${framesSent} frames for ${decoder.numBlocks} blocks`
  );
});

test('progress is monotonic and result() withholds until complete', () => {
  const payload = payloadOf(1024);
  const encoder = new FountainEncoder(payload, 64);
  const decoder = new FountainDecoder(encoder.numBlocks, 64, payload.length);

  let previous = 0;
  for (let seed = 1; seed <= 500 && !decoder.isComplete; seed += 1) {
    if (!decoder.isComplete) assert.equal(decoder.result(), null);
    decoder.addFrame(seed, encoder.encode(seed));

    assert.ok(decoder.progress >= previous, 'progress went backwards');
    previous = decoder.progress;
  }

  assert.ok(decoder.isComplete);
  assert.notEqual(decoder.result(), null);
});

test('a wrong-sized frame is rejected rather than corrupting state', () => {
  const payload = payloadOf(256);
  const encoder = new FountainEncoder(payload, 32);
  const decoder = new FountainDecoder(encoder.numBlocks, 32, payload.length);

  assert.equal(decoder.addFrame(1, new Uint8Array(16)), false);
  assert.equal(decoder.progress, 0);

  for (let seed = 1; seed <= 200 && !decoder.isComplete; seed += 1) {
    decoder.addFrame(seed, encoder.encode(seed));
  }
  assert.deepEqual(decoder.result(), payload);
});

test('an empty payload is refused', () => {
  assert.throws(() => new FountainEncoder(new Uint8Array(0), 64), /empty/);
});
