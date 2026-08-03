/**
 * QR decoding for browsers without `BarcodeDetector`.
 *
 * That is not a small minority: Safari and every browser on iOS have no native
 * decoder, Firefox has none, and Brave ships Chromium but disables the API as a
 * fingerprinting surface. Without this module, receiving only works in stock
 * Chrome and Edge.
 *
 * The wasm binary is bundled as a local asset, never fetched from a CDN.
 * zxing-wasm's default `locateFile` points at jsDelivr, which would fail the
 * app's `default-src 'self'` CSP and break offline use -- the entire premise
 * here. Overriding it is mandatory, not an optimisation.
 */

import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

import type { QrTextDecoder } from './scanner.ts';

let modulePromise: Promise<unknown> | null = null;

/** Instantiate the wasm module once, from the bundled asset. */
function loadModule(): Promise<unknown> {
  modulePromise ??= prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? wasmUrl : prefix + path,
    },
    fireImmediately: true,
  });
  return modulePromise;
}

/**
 * Reused across frames. Allocating a canvas per detection at 15fps churns
 * enough memory to visibly cost frame rate on a phone.
 */
let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

function grabFrame(video: HTMLVideoElement): ImageData | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) return null;

  if (!scratch) {
    scratch = document.createElement('canvas');
    // willReadFrequently: we read back every single frame.
    scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
  }
  if (!scratchCtx || !scratch) return null;

  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }

  scratchCtx.drawImage(video, 0, 0, width, height);
  return scratchCtx.getImageData(0, 0, width, height);
}

/**
 * A decoder tuned for streaming rather than for one difficult still.
 *
 * Frames arrive continuously, so it is better to fail fast on a blurred one and
 * decode the next than to spend the whole frame budget rescuing it. tryHarder,
 * tryInvert and tryRotate are all off for that reason -- QR finder patterns
 * carry orientation, so rotation is handled natively regardless.
 */
export function createZxingDecoder(): QrTextDecoder {
  return {
    async decode(video: HTMLVideoElement): Promise<string[]> {
      await loadModule();

      const imageData = grabFrame(video);
      if (!imageData) return [];

      const results = await readBarcodes(imageData, {
        formats: ['QRCode'],
        maxNumberOfSymbols: 1,
        tryHarder: false,
        tryInvert: false,
        tryRotate: false,
      });

      return results.filter((result) => result.isValid).map((result) => result.text);
    },
  };
}

/** Warm the wasm module so the first camera frame is not the one that pays. */
export async function preloadZxing(): Promise<void> {
  await loadModule();
}
