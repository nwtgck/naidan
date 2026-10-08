import { z } from 'zod';

export class UnrepresentableRpcValueError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super('Retained RPC data cannot be safely captured or serialized', { cause });
    this.name = 'UnrepresentableRpcValueError';
  }
}

/** Non-executable RPC data retained solely for lossless persistence. */
class RpcValue {
  readonly #raw: unknown;

  constructor({ raw }: { raw: unknown }) {
    this.#raw = withRpcRetentionFailure({
      operation: () => {
        assertJson({ value: raw, ancestors: new Set(), allowUndefined: true });
        return structuredClone(raw);
      },
    });
    Object.freeze(this);
  }

  copy(): UnavailableRpcValue {
    return new UnavailableRpcValue({ raw: this.#raw });
  }

  read(): unknown {
    return withRpcRetentionFailure({ operation: () => structuredClone(this.#raw) });
  }

  json(): unknown {
    return withRpcRetentionFailure({
      operation: () => {
        assertJson({ value: this.#raw, ancestors: new Set(), allowUndefined: false });
        z.json().parse(this.#raw);
        return this.read();
      },
    });
  }

  equals({ other }: { other: UnavailableRpcValue }): boolean {
    return equal({ left: this.#raw, right: other.read() });
  }
}

// Structural public type survives Vue ref unwrapping; instances remain frozen.
export type UnavailableRpcValue = Pick<RpcValue, keyof RpcValue>;
export const UnavailableRpcValue = RpcValue;

// Native clone/validation resource failures must have the same fail-closed
// classification as an explicitly rejected value, including during reparsing.
function withRpcRetentionFailure<T>({ operation }: { operation: () => T }): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof UnrepresentableRpcValueError) throw cause;
    throw new UnrepresentableRpcValueError({ cause });
  }
}

function equal({ left, right }: { left: unknown, right: unknown }): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Reflect.ownKeys(left), otherKeys = Reflect.ownKeys(right);
  return keys.length === otherKeys.length && keys.every(key => Object.hasOwn(right, key)
    && equal({ left: Reflect.get(left, key), right: Reflect.get(right, key) }));
}

// JSON.stringify would silently erase undefined properties and replace invalid
// array values. Reject these only inside retained raw leaves, before any write.
function assertJson({ value, ancestors, allowUndefined }: { value: unknown, ancestors: Set<object>, allowUndefined: boolean }): void {
  if (value === undefined && allowUndefined) return;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) throw new UnrepresentableRpcValueError({ cause: undefined });
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new UnrepresentableRpcValueError({ cause: undefined });
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && keys.length !== value.length + 1) throw new UnrepresentableRpcValueError({ cause: undefined });
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue;
    if (Array.isArray(value) && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new UnrepresentableRpcValueError({ cause: undefined });
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new UnrepresentableRpcValueError({ cause: undefined });
    assertJson({ value: descriptor.value, ancestors, allowUndefined });
  }
  ancestors.delete(value);
}

export const TEST_ONLY = {
};
