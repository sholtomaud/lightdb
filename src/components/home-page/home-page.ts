import { BaseComponent } from '../../core/base-component.ts';
import { appStore, initDb, type AppState } from '../../store/app-store.ts';
import { hasNativeQrDecoding } from '../../optical/scanner.ts';
import template from './home-page.html?raw';
import style from './home-page.css?raw';

export class HomePageComponent extends BaseComponent {
  static tagName = 'home-page';
  private unsubscribe: (() => void) | null = null;

  constructor() {
    super(template, style);
  }

  init() {
    if (!hasNativeQrDecoding()) {
      this.querySelector('[data-support]')?.removeAttribute('hidden');
    }

    this.unsubscribe = appStore.subscribe((state) => this.paint(state));
    this.paint(appStore.getState());
    void initDb();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private paint(state: AppState) {
    const recordCount = this.querySelector('[data-record-count]');
    if (recordCount) recordCount.textContent = String(state.records.length);

    const opCount = this.querySelector('[data-op-count]');
    if (opCount) opCount.textContent = String(state.opCount);

    const actor = this.querySelector('[data-actor]');
    if (actor) actor.textContent = state.actor || '…';
  }
}

if (!customElements.get(HomePageComponent.tagName)) {
  customElements.define(HomePageComponent.tagName, HomePageComponent);
}
