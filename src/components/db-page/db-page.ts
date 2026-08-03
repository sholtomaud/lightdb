import { BaseComponent } from '../../core/base-component.ts';
import {
  appStore,
  deleteRecord,
  initDb,
  resetAll,
  setRecord,
  type AppState,
} from '../../store/app-store.ts';
import template from './db-page.html?raw';
import style from './db-page.css?raw';

export class DbPageComponent extends BaseComponent {
  static tagName = 'db-page';
  private unsubscribe: (() => void) | null = null;

  constructor() {
    super(template, style);
  }

  init() {
    this.delegate('click', '#set-btn', () => void this.commit());
    this.delegate('keypress', 'input[type="text"]', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') void this.commit();
    });
    this.delegate('click', '.delete-record', (_event, element) => {
      const key = element.getAttribute('data-key');
      if (key) void deleteRecord(key);
    });
    this.delegate('click', '#reset-btn', () => {
      if (confirm('Erase the local database? This cannot be undone.')) {
        void resetAll();
      }
    });

    this.unsubscribe = appStore.subscribe((state) => this.paint(state));
    this.paint(appStore.getState());
    void initDb();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async commit(): Promise<void> {
    const keyInput = this.querySelector('#key-input') as HTMLInputElement | null;
    const valueInput = this.querySelector('#value-input') as HTMLInputElement | null;
    if (!keyInput || !valueInput) return;

    const key = keyInput.value.trim();
    if (!key) {
      keyInput.focus();
      return;
    }

    await setRecord(key, valueInput.value);
    keyInput.value = '';
    valueInput.value = '';
    keyInput.focus();
  }

  private paint(state: AppState) {
    const status = this.querySelector('[data-status]');
    if (status) status.textContent = state.status;

    const count = this.querySelector('[data-count]');
    if (count) count.textContent = String(state.records.length);

    const list = this.querySelector('#record-list');
    const empty = this.querySelector('#empty-state');
    const itemTemplate = this.querySelector('#record-template') as HTMLTemplateElement | null;
    if (!list || !itemTemplate) return;

    list.innerHTML = '';
    empty?.classList.toggle('hidden', state.records.length > 0);

    for (const [key, value] of state.records) {
      const node = itemTemplate.content.cloneNode(true) as DocumentFragment;
      // textContent, never innerHTML: record values are arbitrary user input.
      (node.querySelector('.record-key') as HTMLElement).textContent = key;
      (node.querySelector('.record-value') as HTMLElement).textContent = value;
      (node.querySelector('.delete-record') as HTMLElement).setAttribute('data-key', key);
      list.appendChild(node);
    }
  }
}

if (!customElements.get(DbPageComponent.tagName)) {
  customElements.define(DbPageComponent.tagName, DbPageComponent);
}
