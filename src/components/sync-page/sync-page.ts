import { BaseComponent } from '../../core/base-component.ts';
import { DuplexSync, type DuplexState } from '../../db/duplex.ts';
import {
  appStore,
  deleteRecord,
  initDb,
  setRecord,
  type AppState,
} from '../../store/app-store.ts';
import template from './sync-page.html?raw';
import style from './sync-page.css?raw';

/**
 * The whole app on one page: the optical link on the left, the database it
 * feeds on the right, so a sync can be watched landing rather than reported
 * after the fact.
 */
export class SyncPageComponent extends BaseComponent {
  static tagName = 'sync-page';

  private duplex: DuplexSync | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Keys present at the last paint, so new arrivals can be highlighted. */
  private knownKeys = new Set<string>();
  private firstPaint = true;

  constructor() {
    super(template, style);
  }

  init() {
    this.delegate('click', '#sync-btn', () => void this.toggleSync());
    this.delegate('click', '#add-btn', () => void this.addRecord());
    this.delegate('keypress', 'input[type="text"]', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') void this.addRecord();
    });
    this.delegate('click', '.delete-record', (_event, element) => {
      const key = element.getAttribute('data-key');
      if (key) void this.removeRecord(key);
    });

    this.unsubscribe = appStore.subscribe((state) => this.paintDatabase(state));

    void initDb().then(() => this.paintDatabase(appStore.getState()));
  }

  disconnectedCallback() {
    this.duplex?.stop();
    this.duplex = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // ------------------------------------------------------------- the link

  private async toggleSync(): Promise<void> {
    if (this.duplex) {
      this.duplex.stop();
      this.duplex = null;
      this.setSyncButton(false);
      return;
    }

    const canvas = this.querySelector('#qr-canvas') as HTMLCanvasElement | null;
    const video = this.querySelector('#camera') as HTMLVideoElement | null;
    if (!canvas || !video) return;

    await initDb();

    const duplex = new DuplexSync(canvas, video);
    duplex.onChange = (state) => this.paintLink(state);
    this.duplex = duplex;

    this.setSyncButton(true);
    await duplex.start();
  }

  private setSyncButton(running: boolean): void {
    const button = this.querySelector('#sync-btn');
    if (button) button.textContent = running ? 'Stop sync' : 'Start sync';
  }

  private paintLink(state: DuplexState): void {
    this.setText('[data-status]', state.message);

    const status = this.querySelector('[data-status]');
    if (status) status.className = `status ${state.tone}`;

    this.setText(
      '[data-link-detail]',
      state.converged ? 'duplex · in sync' : state.running ? 'duplex · live' : 'duplex · idle'
    );

    // The link closes itself once converged, so the button has to follow. Both
    // conditions matter: `running` is also false during start-up, while the
    // decoder is still resolving, and resetting there would undo the click
    // that just started the sync.
    if (!state.running && state.converged && this.duplex) {
      this.duplex = null;
      this.setSyncButton(false);
    }

    // Transmit
    this.querySelector('.frame.light')?.classList.toggle('running', state.transmit !== null);
    if (state.transmit) {
      this.setText('[data-tx-frames]', String(state.transmit.framesSent));
      this.setText(
        '[data-tx-blocks]',
        `${state.transmit.numBlocks}×${state.transmit.blockSize}`
      );
      this.setText('[data-tx-passes]', state.transmit.passes.toFixed(1));
    }

    // Receive
    this.querySelector('.frame.dark')?.classList.toggle(
      'running',
      state.running && !state.cameraError
    );
    this.setText('[data-rx-frames]', String(state.receiveFrames));
    this.setText(
      '[data-rx-blocks]',
      state.receiveBlocks
        ? `${state.receiveBlocks.solved}/${state.receiveBlocks.total}`
        : '—'
    );
    this.setText('[data-peer]', state.peer ? state.peer.slice(0, 8) : '—');

    const bar = this.querySelector('[data-rx-bar]') as HTMLElement | null;
    if (bar) bar.style.width = `${state.receiveProgress * 100}%`;
  }

  // --------------------------------------------------------- the database

  private async addRecord(): Promise<void> {
    const keyInput = this.querySelector('#key-input') as HTMLInputElement | null;
    const valueInput = this.querySelector('#value-input') as HTMLInputElement | null;
    if (!keyInput || !valueInput) return;

    const key = keyInput.value.trim();
    if (!key) {
      keyInput.focus();
      return;
    }
    const value = valueInput.value;

    // Clear before awaiting, not after. Persistence is asynchronous, and
    // clearing on the far side of it wipes whatever was typed in the meantime
    // -- which silently drops records when entries come fast.
    keyInput.value = '';
    valueInput.value = '';
    keyInput.focus();

    await setRecord(key, value);

    // Push the edit out immediately rather than waiting for the next restart.
    await this.duplex?.localChange();
  }

  private async removeRecord(key: string): Promise<void> {
    await deleteRecord(key);
    await this.duplex?.localChange();
  }

  private paintDatabase(state: AppState): void {
    this.setText('[data-actor]', state.actor ? state.actor.slice(0, 8) : '…');
    this.setText('[data-count]', String(state.records.length));
    this.setText('[data-ops]', String(state.opCount));

    const table = this.querySelector('[data-table]') as HTMLElement | null;
    const empty = this.querySelector('[data-empty]') as HTMLElement | null;
    const tbody = this.querySelector('[data-tbody]');
    const rowTemplate = this.querySelector('#record-row') as HTMLTemplateElement | null;
    if (!table || !empty || !tbody || !rowTemplate) return;

    const hasRecords = state.records.length > 0;
    table.toggleAttribute('hidden', !hasRecords);
    empty.classList.toggle('hidden', hasRecords);

    tbody.innerHTML = '';
    for (const [key, value] of state.records) {
      const node = rowTemplate.content.cloneNode(true) as DocumentFragment;
      const row = node.querySelector('tr') as HTMLElement;

      // textContent, never innerHTML: record values are arbitrary remote input.
      (node.querySelector('.key') as HTMLElement).textContent = key;
      (node.querySelector('.value') as HTMLElement).textContent = value;
      (node.querySelector('.delete-record') as HTMLElement).setAttribute('data-key', key);

      // Highlight only genuinely new keys, and never on the first paint, or
      // reloading a full database would flash every row at once.
      if (!this.firstPaint && !this.knownKeys.has(key)) {
        row.classList.add('arrived');
      }
      tbody.appendChild(node);
    }

    this.knownKeys = new Set(state.records.map(([key]) => key));
    this.firstPaint = false;
  }

  private setText(selector: string, text: string): void {
    const element = this.querySelector(selector);
    if (element) element.textContent = text;
  }
}

if (!customElements.get(SyncPageComponent.tagName)) {
  customElements.define(SyncPageComponent.tagName, SyncPageComponent);
}
