/**
 * Receiving half of the optical link: camera in, reassembled payload out.
 *
 * Decoding is behind the `QrTextDecoder` interface on purpose. The built-in
 * `BarcodeDetector` is Chromium-only -- Safari, iOS (every browser on it) and
 * Firefox have no native QR decode. Those platforms need a WASM decoder
 * registered via `setQrDecoder()`; nothing else in the app changes.
 */

import { FountainDecoder } from './fountain.ts';
import { crc32, decodeFrame, sameSession, type FrameHeader } from './frame.ts';
import { fromBase64Url } from './base64.ts';

export interface QrTextDecoder {
  /** Every QR payload visible in the frame, as text. */
  decode(source: HTMLVideoElement): Promise<string[]>;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

function nativeDetector(): QrTextDecoder | null {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
    .BarcodeDetector;
  if (!Ctor) return null;

  const detector = new Ctor({ formats: ['qr_code'] });
  return {
    async decode(source: HTMLVideoElement): Promise<string[]> {
      const results = await detector.detect(source);
      return results.map((r) => r.rawValue);
    },
  };
}

let decoderOverride: QrTextDecoder | null = null;
let resolved: QrTextDecoder | null = null;
let resolving: Promise<QrTextDecoder | null> | null = null;

/** Install a decoder explicitly, bypassing detection. */
export function setQrDecoder(decoder: QrTextDecoder | null): void {
  decoderOverride = decoder;
  resolved = decoder;
  resolving = null;
}

/** The decoder already resolved, if any. Synchronous; does not trigger a load. */
export function getQrDecoder(): QrTextDecoder | null {
  return decoderOverride ?? resolved ?? nativeDetector();
}

/** True when this browser decodes QR natively, with no wasm needed. */
export function hasNativeQrDecoding(): boolean {
  return nativeDetector() !== null;
}

/**
 * Resolve a decoder, loading the wasm fallback if the browser has no native one.
 *
 * Idempotent and safe to call concurrently. The wasm is behind a dynamic import
 * so browsers with `BarcodeDetector` never download it.
 */
export function ensureQrDecoder(): Promise<QrTextDecoder | null> {
  if (decoderOverride) return Promise.resolve(decoderOverride);
  if (resolved) return Promise.resolve(resolved);

  resolving ??= (async () => {
    const native = nativeDetector();
    if (native) {
      resolved = native;
      return native;
    }

    const { createZxingDecoder, preloadZxing } = await import('./zxing-decoder.ts');
    await preloadZxing();

    resolved = createZxingDecoder();
    return resolved;
  })().catch((error: Error) => {
    // Let a later attempt retry rather than caching the failure forever.
    resolving = null;
    throw error;
  });

  return resolving;
}

export interface ReceiveProgress {
  header: FrameHeader;
  blocksSolved: number;
  numBlocks: number;
  framesSeen: number;
  progress: number;
}

export interface ScannerOptions {
  /** Detection attempts per second. */
  fps?: number;
  facingMode?: 'environment' | 'user';
}

export class OpticalScanner {
  private video: HTMLVideoElement;
  private options: Required<ScannerOptions>;
  private stream: MediaStream | null = null;
  private timer: number | null = null;
  private decoder: QrTextDecoder | null = null;
  private fountain: FountainDecoder | null = null;
  private header: FrameHeader | null = null;
  private busy = false;

  onProgress: ((progress: ReceiveProgress) => void) | null = null;
  onComplete: ((payload: Uint8Array, header: FrameHeader) => void) | null = null;
  onError: ((error: Error) => void) | null = null;

  constructor(video: HTMLVideoElement, options: ScannerOptions = {}) {
    this.video = video;
    this.options = { fps: 15, facingMode: 'environment', ...options };
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    // Resolves natively or loads the wasm fallback; only throws if both fail.
    this.decoder = await ensureQrDecoder();
    if (!this.decoder) {
      throw new Error('No QR decoder could be loaded in this browser.');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: this.options.facingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();

    const interval = Math.max(1, Math.round(1000 / this.options.fps));
    this.timer = setInterval(() => void this.tick(), interval) as unknown as number;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** Discard progress and wait for a fresh session. */
  reset(): void {
    this.fountain = null;
    this.header = null;
  }

  private async tick(): Promise<void> {
    // Detection is slower than the timer on weaker devices; never queue up.
    if (this.busy) return;
    this.busy = true;

    try {
      const decoder = this.decoder ?? getQrDecoder();
      if (!decoder || this.video.readyState < 2) return;

      const results = await decoder.decode(this.video);
      for (const text of results) {
        this.ingest(text);
      }
    } catch (error) {
      this.onError?.(error as Error);
    } finally {
      this.busy = false;
    }
  }

  /** Feed one decoded QR payload. Exposed for tests and for a paste fallback. */
  ingest(text: string): void {
    const bytes = fromBase64Url(text);
    if (!bytes) return;

    const frame = decodeFrame(bytes);
    if (!frame) return;

    // A different session means the sender restarted; follow it.
    if (this.header && !sameSession(this.header, frame.header)) {
      this.reset();
    }

    if (!this.fountain || !this.header) {
      this.header = frame.header;
      this.fountain = new FountainDecoder(
        frame.header.numBlocks,
        frame.header.blockSize,
        frame.header.totalLength
      );
    }

    const complete = this.fountain.addFrame(frame.header.seed, frame.payload);

    this.onProgress?.({
      header: this.header,
      blocksSolved: Math.round(this.fountain.progress * this.fountain.numBlocks),
      numBlocks: this.fountain.numBlocks,
      framesSeen: this.fountain.framesSeen,
      progress: this.fountain.progress,
    });

    if (!complete) return;

    const payload = this.fountain.result();
    if (!payload) return;

    if (crc32(payload) !== this.header.checksum) {
      this.onError?.(new Error('Checksum mismatch; discarding and restarting'));
      this.reset();
      return;
    }

    const header = this.header;
    this.reset();
    this.onComplete?.(payload, header);
  }
}
