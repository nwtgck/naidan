import { Secret } from './secret';

/**
 * Copy plain in-memory data, including Vue's plain-object proxies. Preserve
 * immutable Secret wrappers by identity without ever revealing their payload.
 * This is NOT a replacement for structuredClone: non-plain objects (including
 * Date, Map, Blob and other classes), functions and accessors are rejected.
 * Preserve cycles, shared references, undefined, symbols and non-enumerable
 * data fields, but make copied fields writable for editing drafts.
 */
export function clonePlainData<T>({ value }: { value: T }): T {
  const copies = new WeakMap<object, object>();
  function copy({ value }: { value: unknown }): unknown {
    if (typeof value === 'function') {
      throw new TypeError('Cannot clone a function as plain data');
    }
    if (typeof value !== 'object' || value === null || value instanceof Secret) {
      return value;
    }
    const existing = copies.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    const isArray = Array.isArray(value);
    if ((!isArray && prototype !== Object.prototype && prototype !== null)
      || (isArray && prototype !== Array.prototype)) {
      throw new TypeError('Cannot clone a non-plain object as plain data');
    }
    const result: object = isArray ? new Array(value.length) : Object.create(prototype === null ? null : Object.prototype);
    copies.set(value, result);
    for (const key of Reflect.ownKeys(value)) {
      if (isArray && key === 'length') {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) {
        throw new TypeError('Cannot clone an accessor as plain data');
      }
      Object.defineProperty(result, key, {
        value: copy({ value: descriptor.value }),
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  // Only the ownership of plain data changes; field types and Secrets do not.
  return copy({ value }) as T;
}

export const TEST_ONLY = {
};
