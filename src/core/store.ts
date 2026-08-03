export class Store<T extends object> extends EventTarget {
  private state: T;

  constructor(initialState: T) {
    super();
    this.state = { ...initialState };
  }

  getState(): T {
    return { ...this.state };
  }

  setState(newState: Partial<T>): void {
    this.state = { ...this.state, ...newState };
    this.dispatchEvent(new CustomEvent('change', { detail: this.getState() }));
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(listener: (state: T) => void): () => void {
    const handler = (e: Event) => listener((e as CustomEvent<T>).detail);
    this.addEventListener('change', handler);
    return () => this.removeEventListener('change', handler);
  }
}
