import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HEADER_SIZE,
  PROTOCOL_VERSION,
  crc32,
  decodeFrame,
  encodeFrame,
  sameSession,
  type FrameHeader,
} from '../src/optical/frame.ts';
import { base64Capacity, fromBase64Url, toBase64Url } from '../src/optical/base64.ts';

function header(overrides: Partial<FrameHeader> = {}): FrameHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    flags: 0,
    sessionId: 0xdeadbeef,
    totalLength: 4321,
    blockSize: 64,
    numBlocks: 68,
    seed: 0x12345678,
    checksum: 0xcafebabe,
    ...overrides,
  };
}

test('CRC-32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('frames round-trip through the wire format', () => {
  const payload = new Uint8Array(64).map((_, i) => (i * 7) & 0xff);
  const original = header();

  const decoded = decodeFrame(encodeFrame(original, payload));
  assert.notEqual(decoded, null);
  assert.deepEqual(decoded?.header, original);
  assert.deepEqual(decoded?.payload, payload);
});

test('the header is exactly the advertised size', () => {
  const payload = new Uint8Array(64);
  assert.equal(encodeFrame(header(), payload).length, HEADER_SIZE + 64);
});

test('32-bit header fields survive values above 2^31', () => {
  const payload = new Uint8Array(8);
  const big = header({
    sessionId: 0xffffffff,
    seed: 0xfffffffe,
    checksum: 0x80000000,
    totalLength: 0xfffffff0,
    blockSize: 8,
  });

  const decoded = decodeFrame(encodeFrame(big, payload));
  assert.equal(decoded?.header.sessionId, 0xffffffff);
  assert.equal(decoded?.header.seed, 0xfffffffe);
  assert.equal(decoded?.header.checksum, 0x80000000);
  assert.equal(decoded?.header.totalLength, 0xfffffff0);
});

test('foreign and truncated data is rejected', () => {
  assert.equal(decodeFrame(new Uint8Array(4)), null, 'too short');
  assert.equal(decodeFrame(new Uint8Array(64)), null, 'wrong magic');

  const good = encodeFrame(header(), new Uint8Array(64));
  assert.equal(decodeFrame(good.subarray(0, HEADER_SIZE + 10)), null, 'truncated payload');

  const wrongVersion = good.slice();
  wrongVersion[2] = 99;
  assert.equal(decodeFrame(wrongVersion), null, 'unknown protocol version');
});

test('a payload that disagrees with blockSize is refused at encode time', () => {
  assert.throws(() => encodeFrame(header({ blockSize: 64 }), new Uint8Array(32)), /expected 64/);
});

test('session identity ignores the per-frame seed', () => {
  const a = header({ seed: 1 });
  const b = header({ seed: 999 });
  assert.ok(sameSession(a, b), 'same transfer, different frame');

  assert.ok(!sameSession(a, header({ sessionId: 1 })));
  assert.ok(!sameSession(a, header({ checksum: 1 })));
  assert.ok(!sameSession(a, header({ numBlocks: 1 })));
});

// --------------------------------------------------------------- base64url

test('base64url round-trips every byte value at every length', () => {
  for (let length = 0; length < 130; length += 1) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 37 + length) & 0xff);
    const decoded = fromBase64Url(toBase64Url(bytes));
    assert.deepEqual(decoded, bytes, `length ${length}`);
  }

  const allBytes = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual(fromBase64Url(toBase64Url(allBytes)), allBytes);
});

test('base64url output is URL and QR safe', () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  assert.match(toBase64Url(bytes), /^[A-Za-z0-9_-]*$/);
});

test('base64url rejects invalid input rather than guessing', () => {
  assert.equal(fromBase64Url('a'), null, 'impossible length');
  assert.equal(fromBase64Url('****'), null, 'characters outside the alphabet');
  assert.equal(fromBase64Url('AB+/'), null, 'standard base64 is not base64url');
});

test('capacity helpers agree with the encoder', () => {
  for (const length of [1, 2, 3, 10, 64, 100]) {
    const bytes = new Uint8Array(length);
    assert.ok(
      base64Capacity(toBase64Url(bytes).length) >= length,
      `capacity understates ${length} bytes`
    );
  }
});

test('a full frame survives the base64 hop the QR decoder forces on us', () => {
  const payload = new Uint8Array(64).map((_, i) => (i * 11) & 0xff);
  const framed = encodeFrame(header(), payload);

  const text = toBase64Url(framed);
  const returned = fromBase64Url(text);
  assert.notEqual(returned, null);

  const decoded = decodeFrame(returned as Uint8Array);
  assert.deepEqual(decoded?.payload, payload);
});
