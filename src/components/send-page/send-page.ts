import { BaseComponent } from '../../core/base-component.ts';
import { getDb, getPersistence, initDb } from '../../store/app-store.ts';
import { buildSyncMessage, encodeSyncMessage } from '../../db/sync.ts';
import { FLAG_GZIP } from '../../optical/frame.ts';
import { OpticalTransmitter, type TransmitStats } from '../../optical/transmitter.ts';
import template from './send-page.html?raw';
import style from './send-page.css?raw';

export class SendPageComponent extends BaseComponent {
  static tagName = 'send-page';
  private transmitter: OpticalTransmitter | null = null;

  constructor() {
    super(template, style);
  }

  init() {
    this.delegate('click', '#start-btn', () => void this.start());
    this.delegate('click', '#stop-btn', () => this.stop());
    void initDb();
  }

  disconnectedCallback() {
    this.stop();
  }

  private async start(): Promise<void> {
    await initDb();

    const canvas = this.querySelector('#qr-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    this.setStatus('Building sync message…');

    try {
      const peerInput = this.querySelector('#peer-input') as HTMLInputElement | null;
      const peer = peerInput?.value.trim() || null;
      const peerVv = peer ? ((await getPersistence().peerVector(peer)) ?? null) : null;

      const message = buildSyncMessage(getDb(), peerVv);
      const { bytes, gzipped } = await encodeSyncMessage(message);

      this.transmitter = new OpticalTransmitter(canvas, { fps: 12, version: 14, ecc: 'L' });
      this.transmitter.onFrame = (stats) => this.paintStats(stats);

      const stats = this.transmitter.start(bytes, gzipped ? FLAG_GZIP : 0);

      this.setStatus(
        `Transmitting ${message.ops.length} op${message.ops.length === 1 ? '' : 's'}` +
          `${gzipped ? ', gzipped' : ''}.`
      );
      this.paintStats(stats);
      this.setRunning(true);
    } catch (error) {
      this.setStatus(`Could not start: ${(error as Error).message}`);
      this.stop();
    }
  }

  private stop(): void {
    this.transmitter?.stop();
    this.transmitter = null;
    this.setRunning(false);
  }

  private setRunning(running: boolean): void {
    const start = this.querySelector('#start-btn') as HTMLButtonElement | null;
    const stop = this.querySelector('#stop-btn') as HTMLButtonElement | null;
    if (start) start.disabled = running;
    if (stop) stop.disabled = !running;
  }

  private setStatus(text: string): void {
    const status = this.querySelector('[data-status]');
    if (status) status.textContent = text;
  }

  private paintStats(stats: TransmitStats): void {
    const set = (selector: string, value: string) => {
      const element = this.querySelector(selector);
      if (element) element.textContent = value;
    };

    set('[data-payload]', `${stats.totalLength} B`);
    set('[data-blocks]', `${stats.numBlocks} × ${stats.blockSize} B`);
    set('[data-frames]', String(stats.framesSent));
    set('[data-passes]', stats.passes.toFixed(2));
  }
}

if (!customElements.get(SendPageComponent.tagName)) {
  customElements.define(SendPageComponent.tagName, SendPageComponent);
}
