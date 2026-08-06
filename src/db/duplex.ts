/**
 * Simultaneous send and receive over one optical link.
 *
 * The two-pass protocol existed because the channel was simplex: a screen talks
 * to a camera, and reversing it meant physically turning a device around. It
 * does not have to be. A laptop's screen and webcam face the same way, and so
 * do a phone's screen and its *front* camera -- so holding the two facing each
 * other gives both directions at once, and the flip disappears.
 *
 * Each side transmits its delta continuously and decodes continuously. The
 * moment a message arrives, the sender learns the peer's version vector and
 * re-encodes a smaller delta. Convergence needs no handshake and no agreement
 * about whose turn it is.
 */

import { FLAG_GZIP } from '../optical/frame.ts';
import { OpticalScanner, ensureQrDecoder } from '../optical/scanner.ts';
import { OpticalTransmitter, type TransmitStats } from '../optical/transmitter.ts';
import type { EccLevel } from '../optical/qr-encode.ts';
import { buildSyncMessage, decodeSyncMessage, encodeSyncMessage, isConverged } from './sync.ts';
import type { VersionVector } from './crdt.ts';
import { getDb, getPersistence, mergeRemoteOps } from '../store/app-store.ts';

export interface DuplexState {
  running: boolean;
  /** Null until a decoder resolves; the wasm fallback takes a moment. */
  decoderReady: boolean;
  cameraError: string | null;

  transmit: TransmitStats | null;
  receiveProgress: number;
  receiveFrames: number;
  receiveBlocks: { solved: number; total: number } | null;

  peer: string | null;
  lastMerged: number | null;
  converged: boolean;
  message: string;
  tone: 'neutral' | 'active' | 'good' | 'bad';
}

export interface DuplexOptions {
  fps?: number;
  version?: number;
  ecc?: EccLevel;
}

const IDLE: DuplexState = {
  running: false,
  decoderReady: false,
  cameraError: null,
  transmit: null,
  receiveProgress: 0,
  receiveFrames: 0,
  receiveBlocks: null,
  peer: null,
  lastMerged: null,
  converged: false,
  message: 'Idle. Start a sync and point the other device at this screen.',
  tone: 'neutral',
};

export class DuplexSync {
  private transmitter: OpticalTransmitter;
  private scanner: OpticalScanner;
  private state: DuplexState = { ...IDLE };
  private peerVv: VersionVector | null = null;
  /** Guards against two re-encodes racing after a burst of frames. */
  private encoding = false;

  onChange: ((state: DuplexState) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement, options: DuplexOptions = {}) {
    this.transmitter = new OpticalTransmitter(canvas, {
      fps: options.fps ?? 12,
      version: options.version ?? 14,
      ecc: options.ecc ?? 'L',
    });
    this.scanner = new OpticalScanner(video, { fps: 15, facingMode: 'user' });

    this.transmitter.onFrame = (stats) => this.patch({ transmit: stats });

    this.scanner.onProgress = (progress) =>
      this.patch({
        receiveProgress: progress.progress,
        receiveFrames: progress.framesSeen,
        receiveBlocks: { solved: progress.blocksSolved, total: progress.numBlocks },
        tone: 'active',
        message: `Receiving · ${progress.blocksSolved}/${progress.numBlocks} blocks`,
      });

    this.scanner.onError = (error) => this.patch({ message: error.message, tone: 'bad' });

    this.scanner.onComplete = (payload, header) => {
      void this.absorb(payload, (header.flags & FLAG_GZIP) !== 0);
    };
  }

  getState(): DuplexState {
    return { ...this.state };
  }

  /**
   * Camera faces the user by default, not the environment.
   *
   * The front camera and the screen point the same way, which is the entire
   * reason both directions can run at once. `environment` would put the lens on
   * the opposite side to the display and reintroduce the flip.
   */
  async start(): Promise<void> {
    if (this.state.running) return;

    this.patch({ message: 'Preparing decoder…', tone: 'active' });

    try {
      await ensureQrDecoder();
      this.patch({ decoderReady: true });
    } catch (error) {
      this.patch({ message: `No QR decoder: ${(error as Error).message}`, tone: 'bad' });
      return;
    }

    // Transmission is useful even if the camera is refused, so start it first
    // and treat a camera failure as degraded rather than fatal.
    await this.retransmit();
    this.patch({ running: true, message: 'Syncing…', tone: 'active' });

    try {
      await this.scanner.start();
    } catch (error) {
      this.patch({
        cameraError: (error as Error).message,
        message: `Transmitting only — camera unavailable: ${(error as Error).message}`,
        tone: 'bad',
      });
    }
  }

  stop(): void {
    this.transmitter.stop();
    this.scanner.stop();
    this.patch({ ...IDLE, decoderReady: this.state.decoderReady });
  }

  /** Local edit: re-encode so the peer sees it on the next frame. */
  async localChange(): Promise<void> {
    if (!this.state.running) return;
    await this.retransmit();
  }

  /**
   * Encode the delta the peer is missing and restart the stream.
   *
   * Changing payload mid-flight is safe: a new session id makes the receiver's
   * `sameSession` check fail, and it resets rather than mixing frames from two
   * different payloads.
   */
  private async retransmit(): Promise<void> {
    if (this.encoding) return;
    this.encoding = true;

    try {
      const message = buildSyncMessage(getDb(), this.peerVv);
      const { bytes, gzipped } = await encodeSyncMessage(message);
      const stats = this.transmitter.start(bytes, gzipped ? FLAG_GZIP : 0);
      this.patch({ transmit: stats });
    } catch (error) {
      this.patch({ message: `Could not transmit: ${(error as Error).message}`, tone: 'bad' });
    } finally {
      this.encoding = false;
    }
  }

  private async absorb(payload: Uint8Array, gzipped: boolean): Promise<void> {
    try {
      const message = await decodeSyncMessage(payload, gzipped);
      const applied = await mergeRemoteOps(message.ops, message.peer, message.vv);

      this.peerVv = message.vv;
      await getPersistence().setPeerVector(message.peer, message.vv);

      const converged = isConverged(getDb(), message.vv);
      this.patch({
        peer: message.peer,
        lastMerged: applied,
        converged,
        receiveProgress: 0,
        receiveBlocks: null,
        tone: converged ? 'good' : 'active',
        message: converged
          ? `In sync with ${message.peer.slice(0, 8)}.`
          : `Merged ${applied} record${applied === 1 ? '' : 's'} from ${message.peer.slice(0, 8)}.`,
      });

      // Now that the peer's vector is known, the next frames carry only what
      // they actually lack -- often nothing but the vector itself.
      await this.retransmit();
    } catch (error) {
      this.patch({ message: `Could not merge: ${(error as Error).message}`, tone: 'bad' });
    }
  }

  private patch(changes: Partial<DuplexState>): void {
    this.state = { ...this.state, ...changes };
    this.onChange?.(this.getState());
  }
}
