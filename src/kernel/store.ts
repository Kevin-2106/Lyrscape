export class Store<T> {
  private listeners = new Set<(state: T) => void>();
  constructor(private value: T) {}
  get(): T { return this.value; }
  set(value: T): void { this.value = value; for (const listener of this.listeners) listener(value); }
  update(change: (state: T) => T): void { this.set(change(this.value)); }
  subscribe(listener: (state: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
