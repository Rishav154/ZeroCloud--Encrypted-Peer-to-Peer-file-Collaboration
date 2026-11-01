type EventMap = Record<string, unknown>;
type Listener<T> = (payload: T) => void;

export class TypedEventEmitter<Events extends EventMap> {
  private readonly listeners = new Map<keyof Events, Set<Listener<unknown>>>();

  on<Key extends keyof Events>(
    event: Key,
    listener: Listener<Events[Key]>,
  ): () => void {
    let eventListeners = this.listeners.get(event);
    if (!eventListeners) {
      eventListeners = new Set();
      this.listeners.set(event, eventListeners);
    }

    const wrapped: Listener<unknown> = (payload) => {
      listener(payload as Events[Key]);
    };
    eventListeners.add(wrapped);
    return () => {
      eventListeners?.delete(wrapped);
      if (eventListeners?.size === 0) this.listeners.delete(event);
    };
  }

  emit<Key extends keyof Events>(event: Key, payload: Events[Key]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}
