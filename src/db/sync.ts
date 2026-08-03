/**
 * Two-pass sync protocol.
 *
 * Optical transfer is simplex: a screen talks to a camera, and reversing it
 * means physically turning a device around. So the protocol is built to
 * converge in exactly two passes and one flip, with no round trips inside a
 * pass.
 *
 *   Pass 1   A's screen -> B's camera
 *            A sends its version vector plus every op B is missing,
 *            using the copy of B's vector it kept from last time.
 *            B merges. B is now fully up to date and knows A's vector.
 *
 *   ~ flip ~
 *
 *   Pass 2   B's screen -> A's camera
 *            B replies with exactly the ops A is missing, computed from the
 *            vector A just sent. A merges. Both sides have converged.
 *
 * A first-ever sync degrades gracefully: with no remembered peer vector, pass 1
 * carries the full op log instead of a delta.
 */

import type { LwwMap, Op, VersionVector } from './crdt.ts';

export const SYNC_PROTOCOL = 1;

export interface SyncMessage {
  v: number;
  /** Sender's replica id, used to remember its vector for next time. */
  peer: string;
  /** Everything the sender holds, so the receiver can compute its reply. */
  vv: VersionVector;
  ops: Op[];
}

/**
 * Build a message for `peerVv`, the last vector we saw from that peer.
 * Pass null on a first sync to send the full log.
 */
export function buildSyncMessage(
  db: LwwMap,
  peerVv: VersionVector | null
): SyncMessage {
  return {
    v: SYNC_PROTOCOL,
    peer: db.actor,
    vv: db.versionVector(),
    ops: db.changesSince(peerVv ?? {}),
  };
}

export interface ApplyResult {
  applied: number;
  /** Ops the sender is missing, ready for the return pass. */
  reply: SyncMessage;
  /** Remember this against `message.peer`. */
  peerVv: VersionVector;
}

/** Merge a received message and prepare the reply. */
export function applySyncMessage(db: LwwMap, message: SyncMessage): ApplyResult {
  if (message.v !== SYNC_PROTOCOL) {
    throw new Error(`Unsupported sync protocol version: ${message.v}`);
  }

  const applied = db.merge(message.ops);

  return {
    applied,
    reply: {
      v: SYNC_PROTOCOL,
      peer: db.actor,
      vv: db.versionVector(),
      ops: db.changesSince(message.vv),
    },
    peerVv: message.vv,
  };
}

/** True when the peer already holds everything we do. */
export function isConverged(db: LwwMap, peerVv: VersionVector): boolean {
  return db.changesSince(peerVv).length === 0;
}

// ----------------------------------------------------------------- the wire

const GZIP_AVAILABLE = typeof globalThis.CompressionStream === 'function';

async function pipeThrough(bytes: Uint8Array, stream: ReadableWritablePair): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart]);
  const piped = blob.stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

export interface EncodedMessage {
  bytes: Uint8Array;
  gzipped: boolean;
}

/**
 * JSON, then gzip when the browser offers it.
 *
 * JSON is not the tightest encoding for an op log -- a columnar binary format
 * would roughly halve it -- but gzip recovers most of the difference and this
 * stays inspectable. Worth revisiting if payloads get large.
 */
export async function encodeSyncMessage(message: SyncMessage): Promise<EncodedMessage> {
  const raw = new TextEncoder().encode(JSON.stringify(message));
  if (!GZIP_AVAILABLE) return { bytes: raw, gzipped: false };

  const deflated = await pipeThrough(raw, new CompressionStream('gzip'));
  // Tiny messages can grow under gzip's header; send whichever is smaller.
  return deflated.length < raw.length
    ? { bytes: deflated, gzipped: true }
    : { bytes: raw, gzipped: false };
}

export async function decodeSyncMessage(
  bytes: Uint8Array,
  gzipped: boolean
): Promise<SyncMessage> {
  let raw = bytes;
  if (gzipped) {
    if (!GZIP_AVAILABLE) throw new Error('Message is gzipped but this browser cannot inflate');
    raw = await pipeThrough(bytes, new DecompressionStream('gzip'));
  }

  const parsed = JSON.parse(new TextDecoder().decode(raw)) as SyncMessage;
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.ops)) {
    throw new Error('Malformed sync message');
  }
  return parsed;
}
