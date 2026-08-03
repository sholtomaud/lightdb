export { html, css } from './template-helpers.ts';

export class BaseComponent extends HTMLElement {
  template: HTMLTemplateElement;
  scopedStyleHtml = '';

  constructor(htmlContent: string, cssContent: string) {
    super();
    const tagName = this.tagName.toLowerCase();
    const scopedCss = cssContent.replace(/:host/g, tagName);
    this.scopedStyleHtml = `<style>${scopedCss}</style>`;
    this.template = document.createElement('template');
    this.template.innerHTML = `${this.scopedStyleHtml}${htmlContent}`;
  }

  connectedCallback() {
    this.appendChild(this.template.content.cloneNode(true));
    this.init();
  }

  init() {}

  /**
   * Helper for event delegation. Listeners attach once on the host and survive
   * innerHTML updates.
   */
  delegate(
    eventType: string,
    selector: string,
    handler: (e: Event, element: HTMLElement) => void
  ) {
    this.addEventListener(eventType, (e: Event) => {
      const target = e.target as HTMLElement | null;
      const element = target?.closest(selector) as HTMLElement | null;
      if (element && this.contains(element)) {
        handler.call(this, e, element);
      }
    });
  }

  /**
   * Declaratively replaces inner HTML, keeping the scoped style tag in front.
   */
  update(newHtml?: string) {
    const content = newHtml !== undefined ? newHtml : this.render();
    this.innerHTML = this.scopedStyleHtml + content;
  }

  render(): string {
    return '';
  }
}
