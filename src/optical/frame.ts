/**
 * Wire format for a single optical frame.
 *
 * Every frame is self-describing: a receiver that joins mid-stream learns the
 * whole session geometry from the first frame it happens to decode. There is no
 * back-channel and no handshake frame to miss.
 *
 *   offset  size  field
 *   0       2     magic 'LD'
 *   2       1     protocol version
 *   3       1     flags
 *   4       4     session id
 *   8       4     total payload length (bytes, before block padding)
 *   12      2     block size
 *   14      2     block count
 *   16      4     fountain seed for this frame
 *   20      4     CRC-32 of the complete payload
 *   24      ...   fountain-coded block, `blockSize` bytes
 */

export const HEADER_SIZE = 24;
export const MAGIC_0 = 0x4c; // 'L'
export const MAGIC_1 = 0x44; // 'D'
export const PROTOCOL_VERSION = 1;

/** Payload was compressed with gzip before block splitting. */
export const FLAG_GZIP = 1 << 0;

export interface FrameHeader {
  protocolVersion: number;
  flags: number;
  sessionId: number;
  totalLength: number;
  blockSize: number;
  numBlocks: number;
  seed: number;
  checksum: number;
}

export interface Frame {
  header: FrameHeader;
  payload: Uint8Array;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeFrame(header: FrameHeader, payload: Uint8Array): Uint8Array {
  if (payload.length !== header.blockSize) {
    throw new RangeError(
      `Frame payload is ${payload.length} bytes, expected ${header.blockSize}`
    );
  }

  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);

  out[0] = MAGIC_0;
  out[1] = MAGIC_1;
  out[2] = header.protocolVersion;
  out[3] = header.flags;
  view.setUint32(4, header.sessionId, false);
  view.setUint32(8, header.totalLength, false);
  view.setUint16(12, header.blockSize, false);
  view.setUint16(14, header.numBlocks, false);
  view.setUint32(16, header.seed, false);
  view.setUint32(20, header.checksum, false);
  out.set(payload, HEADER_SIZE);

  return out;
}

/** Parse a frame, or return null if it is not one of ours. */
export function decodeFrame(bytes: Uint8Array): Frame | null {
  if (bytes.length < HEADER_SIZE) return null;
  if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: FrameHeader = {
    protocolVersion: bytes[2],
    flags: bytes[3],
    sessionId: view.getUint32(4, false),
    totalLength: view.getUint32(8, false),
    blockSize: view.getUint16(12, false),
    numBlocks: view.getUint16(14, false),
    seed: view.getUint32(16, false),
    checksum: view.getUint32(20, false),
  };

  if (header.protocolVersion !== PROTOCOL_VERSION) return null;
  if (header.blockSize === 0 || header.numBlocks === 0) return null;
  if (bytes.length < HEADER_SIZE + header.blockSize) return null;

  return {
    header,
    payload: bytes.subarray(HEADER_SIZE, HEADER_SIZE + header.blockSize),
  };
}

/** Two frames belong to the same transfer. */
export function sameSession(a: FrameHeader, b: FrameHeader): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.totalLength === b.totalLength &&
    a.blockSize === b.blockSize &&
    a.numBlocks === b.numBlocks &&
    a.checksum === b.checksum
  );
}
