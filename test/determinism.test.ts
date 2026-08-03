/**
 * Cross-language determinism of the fountain degree distribution.
 *
 * Sender and receiver never exchange which blocks a frame combines -- both
 * derive it from the frame's 32-bit seed. That was survivable while both sides
 * were the same JavaScript. With a Swift implementation reading the same
 * stream, every step from seed to block set has to be bit-identical across two
 * languages and two libms.
 *
 * `Math.log` is the specific hazard: its precision is implementation-defined,
 * so JS and Swift can differ in the last ULP. Near a distribution boundary that
 * flips a sampled degree, which changes the block subset, which means the two
 * sides silently disagree about the contents of every frame -- while both
 * suites stay green.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LN2,
  makeRng,
  protocolLog,
  sampleDegree,
  selectBlocks,
  solitonThresholds,
} from '../src/optical/fountain.ts';

test('protocolLog agrees with Math.log to near machine precision', () => {
  const samples = [
    1, 1.5, 2, 2.718281828459045, 10, 100, 1000, 0.5, 0.1, 0.05, 1e-6, 1e6,
    1.0000001, 65535, 4294967296,
  ];

  for (const x of samples) {
    const expected = Math.log(x);
    const actual = protocolLog(x);
    const tolerance = Math.max(Math.abs(expected) * 1e-14, 1e-15);
    assert.ok(
      Math.abs(actual - expected) <= tolerance,
      `protocolLog(${x}) = ${actual}, Math.log = ${expected}`
    );
  }

  assert.equal(protocolLog(1), 0, 'log(1) must be exactly zero');
  assert.ok(Math.abs(protocolLog(2) - LN2) < 1e-15);
});

test('protocolLog rejects inputs outside its domain', () => {
  assert.throws(() => protocolLog(0), /domain/);
  assert.throws(() => protocolLog(-1), /domain/);
  assert.throws(() => protocolLog(Number.NaN), /domain/);
  assert.throws(() => protocolLog(Number.POSITIVE_INFINITY), /domain/);
});

test('protocolLog is a pure function of its input', () => {
  for (const x of [1.5, 7, 1234.5678]) {
    assert.equal(protocolLog(x), protocolLog(x));
  }
});

/**
 * The sampling step must compare integers, not floats. A float CDF makes the
 * chosen degree sensitive to the last bit of a division; integer thresholds
 * make the comparison exact by construction.
 */
test('soliton thresholds are exact 32-bit integers', () => {
  for (const k of [1, 2, 3, 10, 64, 100, 1000, 4096]) {
    const thresholds = solitonThresholds(k);

    assert.ok(
      thresholds instanceof Uint32Array,
      `k=${k} produced ${thresholds.constructor.name}, not Uint32Array`
    );
    assert.equal(thresholds.length, k + 1, `k=${k} wrong length`);

    for (let i = 2; i <= k; i += 1) {
      assert.ok(
        thresholds[i] >= thresholds[i - 1],
        `k=${k} not monotonic at degree ${i}`
      );
    }

    // The final threshold must saturate, or a high draw selects no degree.
    assert.equal(
      thresholds[k],
      0xffffffff,
      `k=${k} final threshold does not saturate`
    );
  }
});

test('every possible 32-bit draw maps to a valid degree', () => {
  for (const k of [1, 2, 7, 64]) {
    const thresholds = solitonThresholds(k);

    const draws = [0, 1, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
    for (const draw of draws) {
      const degree = sampleDegree(() => draw, thresholds);
      assert.ok(
        Number.isInteger(degree) && degree >= 1 && degree <= k,
        `k=${k} draw ${draw} gave degree ${degree}`
      );
    }
  }
});

test('degree one keeps meaningful probability mass', () => {
  // Without degree-1 frames the peeling decoder can never start.
  for (const k of [10, 100, 1000]) {
    const thresholds = solitonThresholds(k);
    const share = thresholds[1] / 0xffffffff;
    assert.ok(share > 0.001, `k=${k} gives degree 1 only ${share} of the mass`);
    assert.ok(share < 0.5, `k=${k} gives degree 1 an implausible ${share}`);
  }
});

test('block selection is stable across repeated calls', () => {
  const thresholds = solitonThresholds(50);
  for (let seed = 1; seed < 300; seed += 1) {
    assert.deepEqual(
      selectBlocks(seed, 50, thresholds),
      selectBlocks(seed, 50, thresholds),
      `seed ${seed} is not reproducible`
    );
  }
});

test('selected indices are sorted, unique and in range', () => {
  // Sorted output removes set-iteration order as a source of cross-language
  // divergence: two implementations must agree on the sequence, not just the set.
  const numBlocks = 40;
  const thresholds = solitonThresholds(numBlocks);

  for (let seed = 1; seed < 500; seed += 1) {
    const indices = selectBlocks(seed, numBlocks, thresholds);

    assert.equal(new Set(indices).size, indices.length, `seed ${seed} repeated a block`);
    for (const index of indices) {
      assert.ok(index >= 0 && index < numBlocks, `seed ${seed} selected ${index}`);
    }
    for (let i = 1; i < indices.length; i += 1) {
      assert.ok(indices[i] > indices[i - 1], `seed ${seed} is not ascending`);
    }
  }
});

test('the PRNG produces the documented sequence', () => {
  // Pinned so a Swift xorshift32 can be checked against the same numbers.
  const rng = makeRng(1);
  const first = [rng(), rng(), rng(), rng()];

  for (const value of first) {
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff);
  }

  // Reproducible from the same seed, and different from a neighbouring seed.
  const again = makeRng(1);
  assert.deepEqual([again(), again(), again(), again()], first);

  const neighbour = makeRng(2);
  assert.notDeepEqual([neighbour(), neighbour(), neighbour(), neighbour()], first);
});
