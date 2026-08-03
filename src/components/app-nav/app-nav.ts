import { BaseComponent } from '../../core/base-component.ts';
import template from './app-nav.html?raw';
import style from './app-nav.css?raw';

export class AppNavComponent extends BaseComponent {
  static tagName = 'app-nav';

  constructor() {
    super(template, style);
  }
}

if (!customElements.get(AppNavComponent.tagName)) {
  customElements.define(AppNavComponent.tagName, AppNavComponent);
}
