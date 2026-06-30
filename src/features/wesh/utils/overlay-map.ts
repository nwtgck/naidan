export class WeshOverlayMap<K, V> implements Map<K, V> {
  private writable: Map<K, V> | undefined;
  private readonly source: ReadonlyMap<K, V>;
  readonly [Symbol.toStringTag] = 'Map';

  constructor({
    source,
  }: {
    source: ReadonlyMap<K, V>,
  }) {
    this.source = source;
  }

  private current(): ReadonlyMap<K, V> {
    return this.writable ?? this.source;
  }

  private ensureWritable(): Map<K, V> {
    this.writable ??= new Map(this.source);
    return this.writable;
  }

  get size(): number {
    return this.current().size;
  }

  clear(): void {
    this.ensureWritable().clear();
  }

  delete(key: K): boolean {
    return this.ensureWritable().delete(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.current().entries();
  }

  forEach(callbackfn: Parameters<Map<K, V>['forEach']>[0], thisArg?: Parameters<Map<K, V>['forEach']>[1]): void {
    for (const [key, value] of this.current()) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  get(key: K): V | undefined {
    return this.current().get(key);
  }

  has(key: K): boolean {
    return this.current().has(key);
  }

  getOrInsert(key: K, defaultValue: V): V {
    const existingValue = this.current().get(key);

    if (existingValue !== undefined || this.current().has(key)) {
      return existingValue as V;
    }

    this.ensureWritable().set(key, defaultValue);
    return defaultValue;
  }

  getOrInsertComputed(key: K, callback: Parameters<Map<K, V>['getOrInsertComputed']>[1]): V {
    const existingValue = this.current().get(key);

    if (existingValue !== undefined || this.current().has(key)) {
      return existingValue as V;
    }

    const value = callback(key);
    this.ensureWritable().set(key, value);
    return value;
  }

  keys(): MapIterator<K> {
    return this.current().keys();
  }

  set(key: K, value: V): this {
    this.ensureWritable().set(key, value);
    return this;
  }

  values(): MapIterator<V> {
    return this.current().values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
