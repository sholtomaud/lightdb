/**
 * base64url, unpadded.
 *
 * Frames are binary, but every browser QR decoder hands us a *string*
 * (`BarcodeDetector` exposes `rawValue`, never raw bytes) and the charset it
 * assumes for QR byte mode varies by platform -- ISO-8859-1 on some, UTF-8 on
 * others. Round-tripping arbitrary bytes through that is not portable, so we
 * put only ASCII on the wire.
 *
 * Cost: 33% expansion. Base45 over QR *alphanumeric* mode would cost ~3%
 * instead, but needs a second segment mode in the encoder. See README.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const REVERSE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/** Bytes that `n` base64url characters can carry. */
export function base64Capacity(chars: number): number {
  return Math.floor((chars * 3) / 4);
}

/** Characters needed to encode `n` bytes. */
export function base64Length(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      ALPHABET[(n >>> 18) & 63] +
      ALPHABET[(n >>> 12) & 63] +
      ALPHABET[(n >>> 6) & 63] +
      ALPHABET[n & 63];
  }

  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >>> 18) & 63] + ALPHABET[(n >>> 12) & 63];
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      ALPHABET[(n >>> 18) & 63] +
      ALPHABET[(n >>> 12) & 63] +
      ALPHABET[(n >>> 6) & 63];
  }

  return out;
}

/** Decode base64url. Returns null on any character outside the alphabet. */
export function fromBase64Url(text: string): Uint8Array | null {
  const clean = text.trim();
  const remainder = clean.length % 4;
  if (remainder === 1) return null;

  const out = new Uint8Array(base64Capacity(clean.length));
  let outIndex = 0;
  let accumulator = 0;
  let bits = 0;

  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? REVERSE[code] : -1;
    if (value < 0) return null;

    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (accumulator >>> bits) & 0xff;
      outIndex += 1;
    }
  }

  return out.subarray(0, outIndex);
}
