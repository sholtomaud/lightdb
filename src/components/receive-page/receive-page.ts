import { BaseComponent } from '../../core/base-component.ts';
import { initDb, mergeRemoteOps } from '../../store/app-store.ts';
import { decodeSyncMessage } from '../../db/sync.ts';
import { FLAG_GZIP, type FrameHeader } from '../../optical/frame.ts';
import {
  OpticalScanner,
  hasNativeQrDecoding,
  type ReceiveProgress,
} from '../../optical/scanner.ts';
import template from './receive-page.html?raw';
import style from './receive-page.css?raw';

export class ReceivePageComponent extends BaseComponent {
  static tagName = 'receive-page';
  private scanner: OpticalScanner | null = null;

  constructor() {
    super(template, style);
  }

  init() {
    if (!hasNativeQrDecoding()) {
      this.querySelector('[data-unsupported]')?.removeAttribute('hidden');
      const start = this.querySelector('#start-btn') as HTMLButtonElement | null;
      if (start) start.disabled = true;
    }

    this.delegate('click', '#start-btn', () => void this.start());
    this.delegate('click', '#stop-btn', () => this.stop());
    void initDb();
  }

  disconnectedCallback() {
    this.stop();
  }

  private async start(): Promise<void> {
    await initDb();

    const video = this.querySelector('#camera') as HTMLVideoElement | null;
    if (!video) return;

    this.scanner = new OpticalScanner(video, { fps: 15, facingMode: 'environment' });
    this.scanner.onProgress = (progress) => this.paintProgress(progress);
    this.scanner.onError = (error) => this.setStatus(error.message);
    this.scanner.onComplete = (payload, header) => void this.ingest(payload, header);

    try {
      await this.scanner.start();
      this.setStatus('Scanning…');
      this.setRunning(true);
    } catch (error) {
      this.setStatus(`Camera unavailable: ${(error as Error).message}`);
      this.stop();
    }
  }

  private stop(): void {
    this.scanner?.stop();
    this.scanner = null;
    this.setRunning(false);
  }

  private async ingest(payload: Uint8Array, header: FrameHeader): Promise<void> {
    this.setStatus('Payload complete, merging…');

    try {
      const message = await decodeSyncMessage(payload, (header.flags & FLAG_GZIP) !== 0);
      const applied = await mergeRemoteOps(message.ops, message.peer, message.vv);

      this.setStatus(
        applied > 0
          ? `Merged ${applied} op${applied === 1 ? '' : 's'} from ${message.peer}. ` +
              `Now flip the devices and send back.`
          : `Already up to date with ${message.peer}.`
      );
    } catch (error) {
      this.setStatus(`Could not merge: ${(error as Error).message}`);
    }
  }

  private setRunning(running: boolean): void {
    const start = this.querySelector('#start-btn') as HTMLButtonElement | null;
    const stop = this.querySelector('#stop-btn') as HTMLButtonElement | null;
    if (start) start.disabled = running || !hasNativeQrDecoding();
    if (stop) stop.disabled = !running;
  }

  private setStatus(text: string): void {
    const status = this.querySelector('[data-status]');
    if (status) status.textContent = text;
  }

  private paintProgress(progress: ReceiveProgress): void {
    const set = (selector: string, value: string) => {
      const element = this.querySelector(selector);
      if (element) element.textContent = value;
    };

    set('[data-blocks]', `${progress.blocksSolved}/${progress.numBlocks}`);
    set('[data-frames]', String(progress.framesSeen));
    set('[data-progress]', `${Math.round(progress.progress * 100)}%`);

    const bar = this.querySelector('[data-bar]') as HTMLElement | null;
    if (bar) bar.style.width = `${progress.progress * 100}%`;
  }
}

if (!customElements.get(ReceivePageComponent.tagName)) {
  customElements.define(ReceivePageComponent.tagName, ReceivePageComponent);
}
