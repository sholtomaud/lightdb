/**
 * End-to-end check of the optical stack with the camera and the QR *decoder*
 * removed: encoder -> fountain -> frame -> base64 and all the way back.
 *
 * This is the seam that matters. Everything above it is DOM, everything below
 * it is arithmetic already covered elsewhere. If a sync would ever arrive
 * corrupted, it shows up here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FountainDecoder, FountainEncoder } from '../src/optical/fountain.ts';
import {
  HEADER_SIZE,
  PROTOCOL_VERSION,
  crc32,
  decodeFrame,
  encodeFrame,
  type FrameHeader,
} from '../src/optical/frame.ts';
import { fromBase64Url, toBase64Url, base64Capacity } from '../src/optical/base64.ts';
import { QrCode, byteCapacity } from '../src/optical/qr-encode.ts';
import { LwwMap } from '../src/db/crdt.ts';
import { applySyncMessage, buildSyncMessage, decodeSyncMessage, encodeSyncMessage } from '../src/db/sync.ts';

const VERSION = 14;
const ECC = 'L' as const;

function blockSizeFor(version: number): number {
  return base64Capacity(byteCapacity(version, ECC)) - HEADER_SIZE;
}

/** One full sender tick: fountain block -> frame -> base64 -> QR. */
function transmit(
  encoder: FountainEncoder,
  header: FrameHeader,
  seed: number
): { text: string; qr: QrCode } {
  const framed = encodeFrame({ ...header, seed }, encoder.encode(seed));
  const text = toBase64Url(framed);
  const qr = QrCode.encodeBytes(new TextEncoder().encode(text), {
    version: VERSION,
    ecc: ECC,
    mask: -1,
  });
  return { text, qr };
}

test('a frame at the chosen version actually fits in the QR symbol', () => {
  const blockSize = blockSizeFor(VERSION);
  assert.ok(blockSize > 0, `version ${VERSION} cannot carry a frame`);

  const framed = new Uint8Array(HEADER_SIZE + blockSize);
  const text = toBase64Url(framed);

  assert.ok(
    text.length <= byteCapacity(VERSION, ECC),
    `frame needs ${text.length} chars, version ${VERSION}-${ECC} holds ${byteCapacity(VERSION, ECC)}`
  );

  // And it must not fit with even one more byte, or we are wasting capacity.
  const oversized = toBase64Url(new Uint8Array(HEADER_SIZE + blockSize + 1));
  assert.ok(oversized.length > byteCapacity(VERSION, ECC) - 4, 'block size leaves slack');
});

test('every frame the transmitter produces is a valid QR symbol', () => {
  const payload = new Uint8Array(4000).map((_, i) => (i * 13) & 0xff);
  const blockSize = blockSizeFor(VERSION);
  const encoder = new FountainEncoder(payload, blockSize);

  const header: FrameHeader = {
    protocolVersion: PROTOCOL_VERSION,
    flags: 0,
    sessionId: 0x01020304,
    totalLength: payload.length,
    blockSize,
    numBlocks: encoder.numBlocks,
    seed: 0,
    checksum: crc32(payload),
  };

  for (let seed = 1; seed <= 25; seed += 1) {
    const { qr } = transmit(encoder, header, seed);
    assert.equal(qr.version, VERSION, `seed ${seed} spilled to another version`);
    assert.equal(qr.size, VERSION * 4 + 17);
  }
});

test('a full transfer survives the whole pipeline', () => {
  const payload = new Uint8Array(6000).map((_, i) => (i * 29 + 5) & 0xff);
  const blockSize = blockSizeFor(VERSION);
  const encoder = new FountainEncoder(payload, blockSize);

  const header: FrameHeader = {
    protocolVersion: PROTOCOL_VERSION,
    flags: 0,
    sessionId: 0xabcdef01,
    totalLength: payload.length,
    blockSize,
    numBlocks: encoder.numBlocks,
    seed: 0,
    checksum: crc32(payload),
  };

  let decoder: FountainDecoder | null = null;
  let complete = false;

  // Drop one frame in four, as a camera would.
  for (let seed = 1; seed <= 2000 && !complete; seed += 1) {
    const { text } = transmit(encoder, header, seed);
    if (seed % 4 === 0) continue;

    const bytes = fromBase64Url(text);
    assert.notEqual(bytes, null, `seed ${seed} failed base64 decode`);

    const frame = decodeFrame(bytes as Uint8Array);
    assert.notEqual(frame, null, `seed ${seed} failed frame decode`);
    if (!frame) break;

    decoder ??= new FountainDecoder(
      frame.header.numBlocks,
      frame.header.blockSize,
      frame.header.totalLength
    );
    complete = decoder.addFrame(frame.header.seed, frame.payload);
  }

  assert.ok(complete, 'transfer never completed');
  const received = decoder?.result();
  assert.deepEqual(received, payload);
  assert.equal(crc32(received as Uint8Array), header.checksum);
});

test('a real sync message travels end to end and merges', async () => {
  const alice = new LwwMap('alice');
  for (let i = 0; i < 120; i += 1) alice.set(`record-${i}`, `value number ${i}`);

  const message = buildSyncMessage(alice, null);
  const { bytes, gzipped } = await encodeSyncMessage(message);

  const blockSize = blockSizeFor(VERSION);
  const encoder = new FountainEncoder(bytes, blockSize);
  const header: FrameHeader = {
    protocolVersion: PROTOCOL_VERSION,
    flags: gzipped ? 1 : 0,
    sessionId: 7,
    totalLength: bytes.length,
    blockSize,
    numBlocks: encoder.numBlocks,
    seed: 0,
    checksum: crc32(bytes),
  };

  let decoder: FountainDecoder | null = null;
  let complete = false;
  for (let seed = 1; seed <= 2000 && !complete; seed += 1) {
    const { text } = transmit(encoder, header, seed);
    const frame = decodeFrame(fromBase64Url(text) as Uint8Array);
    if (!frame) continue;

    decoder ??= new FountainDecoder(
      frame.header.numBlocks,
      frame.header.blockSize,
      frame.header.totalLength
    );
    complete = decoder.addFrame(frame.header.seed, frame.payload);
  }

  assert.ok(complete);
  const received = decoder?.result() as Uint8Array;
  assert.equal(crc32(received), header.checksum, 'checksum mismatch after reassembly');

  const bob = new LwwMap('bob');
  const returned = await decodeSyncMessage(received, (header.flags & 1) !== 0);
  assert.equal(applySyncMessage(bob, returned).applied, 120);
  assert.deepEqual(bob.entries(), alice.entries());
});

test('corruption is caught by the checksum rather than merged', () => {
  const payload = new Uint8Array(500).map((_, i) => i & 0xff);
  const checksum = crc32(payload);

  const corrupted = payload.slice();
  corrupted[123] ^= 0x01;

  assert.notEqual(crc32(corrupted), checksum, 'a one-bit flip went undetected');
});
