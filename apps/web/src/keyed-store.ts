// Per-key subscriptions keep frequent status changes out of the application root.
export class KeyedStore<T> {
  private values: Record<string, T> = {};
  private listeners = new Map<string, Set<() => void>>();
  private all = new Set<() => void>();
  get = (key: string): T | undefined => this.values[key];
  snapshot = () => this.values;
  subscribe = (key: string, listener: () => void) => {
    let group = this.listeners.get(key);
    if (!group) this.listeners.set(key, group = new Set());
    group.add(listener);
    return () => { group.delete(listener); if (!group.size) this.listeners.delete(key); };
  };
  subscribeAll = (listener: () => void) => { this.all.add(listener); return () => { this.all.delete(listener); }; };
  replace = (next: Record<string, T> | ((old: Record<string, T>) => Record<string, T>)) => {
    const value = typeof next === 'function' ? next(this.values) : next;
    const changed = [...new Set([...Object.keys(this.values), ...Object.keys(value)])].filter(key => !Object.is(this.values[key], value[key]));
    if (!changed.length) return;
    this.values = value;
    for (const key of changed) for (const listener of this.listeners.get(key) || []) listener();
    for (const listener of this.all) listener();
  };
  set(key: string, value: T) { if (!Object.is(this.values[key], value)) this.replace({ ...this.values, [key]: value }); }
}
