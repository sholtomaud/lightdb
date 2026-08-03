/**
 * Drives a canvas as the sending half of the optical link: fountain-codes the
 * payload and paints an endless stream of QR frames.
 *
 * The stream never ends on its own. There is no back-channel, so the sender
 * cannot know when the receiver has enough -- a human stops it, or it loops
 * until told otherwise.
 */

import { QrCode, byteCapacity, type EccLevel } from './qr-encode.ts';
import { FountainEncoder } from './fountain.ts';
import {
  HEADER_SIZE,
  PROTOCOL_VERSION,
  crc32,
  encodeFrame,
  type FrameHeader,
} from './frame.ts';
import { base64Capacity, toBase64Url } from './base64.ts';

export interface TransmitterOptions {
  /** Frames per second. Above ~15 most phone cameras start dropping frames. */
  fps?: number;
  ecc?: EccLevel;
  /** Pinned so every frame is the same physical size and the camera can settle. */
  version?: number;
  /** 0-7 to pin, or -1 to score all eight per frame. */
  mask?: number;
  /** Quiet zone in modules. The spec requires 4. */
  quietZone?: number;
  darkColor?: string;
  lightColor?: string;
}

export interface TransmitStats {
  sessionId: number;
  numBlocks: number;
  blockSize: number;
  totalLength: number;
  framesSent: number;
  /** Frames sent divided by blocks needed. 1.0 means one full pass. */
  passes: number;
}

const DEFAULTS = {
  fps: 12,
  ecc: 'L' as EccLevel,
  version: 14,
  mask: -1,
  quietZone: 4,
  darkColor: '#000000',
  lightColor: '#ffffff',
};

/** Payload bytes that fit in one frame at this version and ECC level. */
export function framePayloadSize(version: number, ecc: EccLevel): number {
  const blockBudget = base64Capacity(byteCapacity(version, ecc)) - HEADER_SIZE;
  if (blockBudget < 1) {
    throw new RangeError(
      `Version ${version}-${ecc} is too small to carry a ${HEADER_SIZE}-byte header`
    );
  }
  return blockBudget;
}

export class OpticalTransmitter {
  private canvas: HTMLCanvasElement;
  private options: Required<TransmitterOptions>;
  private encoder: FountainEncoder | null = null;
  private header: FrameHeader | null = null;
  private timer: number | null = null;
  private seed = 0;
  private framesSent = 0;

  /** Called after each painted frame. */
  onFrame: ((stats: TransmitStats) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, options: TransmitterOptions = {}) {
    this.canvas = canvas;
    this.options = { ...DEFAULTS, ...options };
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  get stats(): TransmitStats | null {
    if (!this.encoder || !this.header) return null;
    return {
      sessionId: this.header.sessionId,
      numBlocks: this.encoder.numBlocks,
      blockSize: this.encoder.blockSize,
      totalLength: this.encoder.totalLength,
      framesSent: this.framesSent,
      passes: this.framesSent / this.encoder.numBlocks,
    };
  }

  /** Begin transmitting. Replaces any transfer already in flight. */
  start(payload: Uint8Array, flags = 0): TransmitStats {
    this.stop();

    const { version, ecc } = this.options;
    const blockSize = framePayloadSize(version, ecc);

    this.encoder = new FountainEncoder(payload, blockSize);
    this.header = {
      protocolVersion: PROTOCOL_VERSION,
      flags,
      sessionId: (Math.random() * 0xffffffff) >>> 0,
      totalLength: payload.length,
      blockSize,
      numBlocks: this.encoder.numBlocks,
      seed: 0,
      checksum: crc32(payload),
    };

    this.seed = 1;
    this.framesSent = 0;

    const interval = Math.max(1, Math.round(1000 / this.options.fps));
    this.timer = setInterval(() => this.tick(), interval) as unknown as number;
    this.tick();

    return this.stats as TransmitStats;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (!this.encoder || !this.header) return;

    // Seed 0 is a xorshift32 fixed point, so the sequence starts at 1.
    const seed = this.seed;
    this.seed = (this.seed + 1) >>> 0 || 1;

    const block = this.encoder.encode(seed);
    const framed = encodeFrame({ ...this.header, seed }, block);
    const text = toBase64Url(framed);

    const qr = QrCode.encodeBytes(new TextEncoder().encode(text), {
      ecc: this.options.ecc,
      version: this.options.version,
      mask: this.options.mask,
    });

    this.paint(qr);
    this.framesSent += 1;
    this.onFrame?.(this.stats as TransmitStats);
  }

  private paint(qr: QrCode): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const { quietZone, darkColor, lightColor } = this.options;
    const total = qr.size + quietZone * 2;

    // Integer module scale keeps edges crisp; blurry modules cost decode rate.
    const available = Math.min(this.canvas.width, this.canvas.height);
    const scale = Math.max(1, Math.floor(available / total));
    const drawn = total * scale;
    const offsetX = Math.floor((this.canvas.width - drawn) / 2);
    const offsetY = Math.floor((this.canvas.height - drawn) / 2);

    ctx.fillStyle = lightColor;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.fillStyle = darkColor;
    for (let y = 0; y < qr.size; y += 1) {
      for (let x = 0; x < qr.size; x += 1) {
        if (qr.getModule(x, y)) {
          ctx.fillRect(
            offsetX + (x + quietZone) * scale,
            offsetY + (y + quietZone) * scale,
            scale,
            scale
          );
        }
      }
    }
  }
}
