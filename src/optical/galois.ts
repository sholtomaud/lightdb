/**
 * GF(256) arithmetic over the QR Code primitive polynomial
 * x^8 + x^4 + x^3 + x^2 + 1 (0x11D), plus the Reed-Solomon encoder the
 * QR spec requires.
 *
 * Encoding only. We never decode Reed-Solomon ourselves -- the camera side
 * hands whole QR payloads to a barcode decoder, which does its own error
 * correction before we ever see the bytes.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    EXP[i] = EXP[i - 255];
  }
}

/** Multiply two field elements. */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/**
 * Reed-Solomon divisor (generator polynomial) of the given degree, as
 * coefficients from x^(degree-1) down to x^0. The implicit leading 1 is omitted.
 */
export function rsDivisor(degree: number): Uint8Array {
  if (degree < 1 || degree > 255) {
    throw new RangeError(`Reed-Solomon degree out of range: ${degree}`);
  }

  const result = new Uint8Array(degree);
  result[degree - 1] = 1;

  // Multiply by (x - r) for r = 1, a, a^2, ... a^(degree-1).
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** Reed-Solomon error-correction codewords for `data` under `divisor`. */
export function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i += 1) {
      result[i] ^= gfMul(divisor[i], factor);
    }
  }
  return result;
}
