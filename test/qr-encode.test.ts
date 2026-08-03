import test from 'node:test';
import assert from 'node:assert/strict';

import { gfMul, rsDivisor, rsRemainder } from '../src/optical/galois.ts';
import {
  ECC_LEVELS,
  MAX_VERSION,
  MIN_VERSION,
  QrCode,
  alignmentPatternPositions,
  byteCapacity,
  numDataCodewords,
  numTotalCodewords,
  type EccLevel,
} from '../src/optical/qr-encode.ts';

// --------------------------------------------------------------- GF(256)

test('GF(256) multiplication obeys field laws', () => {
  assert.equal(gfMul(0, 123), 0);
  assert.equal(gfMul(123, 0), 0);
  assert.equal(gfMul(1, 123), 123);
  assert.equal(gfMul(123, 1), 123);

  for (let a = 1; a < 256; a += 37) {
    for (let b = 1; b < 256; b += 41) {
      assert.equal(gfMul(a, b), gfMul(b, a), `commutative at ${a}x${b}`);
      // Associativity, which is what actually breaks if the log tables are wrong.
      for (let c = 1; c < 256; c += 53) {
        assert.equal(gfMul(gfMul(a, b), c), gfMul(a, gfMul(b, c)));
      }
    }
  }
});

/**
 * The defining property of a Reed-Solomon codeword: data followed by its
 * check symbols is exactly divisible by the generator polynomial. If the
 * divisor or the remainder loop were wrong this would not hold.
 */
test('Reed-Solomon codewords are divisible by the generator', () => {
  for (const degree of [7, 10, 13, 17, 22, 28, 30]) {
    const divisor = rsDivisor(degree);

    for (let trial = 0; trial < 20; trial += 1) {
      const data = new Uint8Array(40);
      for (let i = 0; i < data.length; i += 1) {
        data[i] = (trial * 31 + i * 17 + 7) & 0xff;
      }

      const ecc = rsRemainder(data, divisor);
      assert.equal(ecc.length, degree);

      const codeword = new Uint8Array(data.length + ecc.length);
      codeword.set(data, 0);
      codeword.set(ecc, data.length);

      const residual = rsRemainder(codeword, divisor);
      assert.ok(
        residual.every((b) => b === 0),
        `degree ${degree} trial ${trial} left a non-zero residual`
      );
    }
  }
});

// ----------------------------------------------------------- capacity tables

test('total codewords match the published values', () => {
  assert.equal(numTotalCodewords(1), 26);
  assert.equal(numTotalCodewords(2), 44);
  assert.equal(numTotalCodewords(7), 196);
  assert.equal(numTotalCodewords(10), 346);
  assert.equal(numTotalCodewords(25), 1588);
  assert.equal(numTotalCodewords(40), 3706);
});

/**
 * Re-derives the published byte-mode capacities from the two block-structure
 * tables. A single mistyped digit in either table shows up here.
 */
test('byte-mode capacities match the published values', () => {
  const expected: Record<number, Record<EccLevel, number>> = {
    1: { L: 17, M: 14, Q: 11, H: 7 },
    2: { L: 32, M: 26, Q: 20, H: 14 },
    10: { L: 271, M: 213, Q: 151, H: 119 },
    40: { L: 2953, M: 2331, Q: 1663, H: 1273 },
  };

  for (const [version, levels] of Object.entries(expected)) {
    for (const ecc of ECC_LEVELS) {
      assert.equal(
        byteCapacity(Number(version), ecc),
        levels[ecc],
        `version ${version}-${ecc}`
      );
    }
  }
});

test('every version and level has a self-consistent block structure', () => {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
    for (const ecc of ECC_LEVELS) {
      const total = numTotalCodewords(version);
      const data = numDataCodewords(version, ecc);

      assert.ok(data > 0, `version ${version}-${ecc} has no data capacity`);
      assert.ok(data < total, `version ${version}-${ecc} reserves no error correction`);
      // Stronger levels never carry more payload than weaker ones.
      if (ecc !== 'L') {
        assert.ok(
          numDataCodewords(version, 'L') >= data,
          `version ${version}-${ecc} exceeds level L`
        );
      }
    }
  }
});

test('alignment pattern positions match the spec, including version 32', () => {
  assert.deepEqual(alignmentPatternPositions(1), []);
  assert.deepEqual(alignmentPatternPositions(2), [6, 18]);
  assert.deepEqual(alignmentPatternPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPatternPositions(14), [6, 26, 46, 66]);
  // Version 32 is the documented exception to the general spacing rule.
  assert.deepEqual(alignmentPatternPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPatternPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});

// --------------------------------------------------------------- structure

function encode(text: string, options = {}): QrCode {
  return QrCode.encodeBytes(new TextEncoder().encode(text), options);
}

test('encoded symbols have the right geometry', () => {
  for (const version of [1, 2, 7, 14, 27, 40]) {
    const qr = QrCode.encodeBytes(new Uint8Array(8).fill(0x41), { version, ecc: 'L' });
    assert.equal(qr.version, version);
    assert.equal(qr.size, version * 4 + 17);
  }
});

test('finder patterns land in all three corners', () => {
  const qr = encode('lightdb');
  const corners: [number, number][] = [
    [0, 0],
    [qr.size - 7, 0],
    [0, qr.size - 7],
  ];

  for (const [ox, oy] of corners) {
    for (let dy = 0; dy < 7; dy += 1) {
      for (let dx = 0; dx < 7; dx += 1) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(
          qr.getModule(ox + dx, oy + dy),
          ring !== 2,
          `finder at (${ox},${oy}) wrong at (${dx},${dy})`
        );
      }
    }
  }
});

test('timing patterns alternate and the dark module is set', () => {
  const qr = encode('lightdb timing');

  for (let i = 8; i < qr.size - 8; i += 1) {
    assert.equal(qr.getModule(i, 6), i % 2 === 0, `horizontal timing at ${i}`);
    assert.equal(qr.getModule(6, i), i % 2 === 0, `vertical timing at ${i}`);
  }

  // The spec's always-dark module, just above the bottom-left format strip.
  assert.equal(qr.getModule(8, qr.size - 8), true);
});

test('mask selection stays in range and pinning is honoured', () => {
  const auto = encode('choose a mask for me');
  assert.ok(auto.mask >= 0 && auto.mask <= 7);

  for (let mask = 0; mask < 8; mask += 1) {
    assert.equal(encode('pinned', { mask }).mask, mask);
  }
});

test('version selection picks the smallest that fits', () => {
  assert.equal(QrCode.encodeBytes(new Uint8Array(17), { ecc: 'L' }).version, 1);
  assert.equal(QrCode.encodeBytes(new Uint8Array(18), { ecc: 'L' }).version, 2);
  assert.equal(QrCode.encodeBytes(new Uint8Array(32), { ecc: 'L' }).version, 2);
  assert.equal(QrCode.encodeBytes(new Uint8Array(33), { ecc: 'L' }).version, 3);
});

test('overlong payloads are rejected rather than silently truncated', () => {
  assert.throws(
    () => QrCode.encodeBytes(new Uint8Array(2954), { ecc: 'L' }),
    /does not fit/
  );
  assert.throws(
    () => QrCode.encodeBytes(new Uint8Array(20), { version: 1, ecc: 'L' }),
    /exceeds version/
  );
});

test('payloads at exactly the capacity limit still encode', () => {
  for (const ecc of ECC_LEVELS) {
    for (const version of [1, 9, 10, 40]) {
      const limit = byteCapacity(version, ecc);
      const qr = QrCode.encodeBytes(new Uint8Array(limit).fill(0xa5), { version, ecc });
      assert.equal(qr.version, version);
    }
  }
});

test('differing payloads produce differing symbols', () => {
  const a = encode('payload a', { version: 5, ecc: 'L', mask: 0 });
  const b = encode('payload b', { version: 5, ecc: 'L', mask: 0 });

  let differences = 0;
  for (let y = 0; y < a.size; y += 1) {
    for (let x = 0; x < a.size; x += 1) {
      if (a.getModule(x, y) !== b.getModule(x, y)) differences += 1;
    }
  }
  assert.ok(differences > 0, 'two different payloads produced identical symbols');
});
