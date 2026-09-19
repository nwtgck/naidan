export type NativeStreamOperation = 'put' | 'end' | 'on_finalized_text';
export type NativeStreamAvailability =
  | { status: 'not-attempted' }
  | { status: 'available'; restoration: 'pending' | 'restored' | 'failed' | 'ownership-lost' }
  | { status: 'unavailable'; reason: 'already-owned' | 'unsupported-instance' | 'method-descriptor' | 'not-extensible' | 'install-failed' };
export interface NativeStreamRecorder {
  setNativeStreamAvailability({ availability }: { availability: NativeStreamAvailability }): void;
  recordNativeStream({ operation, phase, streamCallOrdinal, args }: {
    operation: NativeStreamOperation; phase: 'entering' | 'returned' | 'threw'; streamCallOrdinal: number; args: readonly unknown[];
  }): void;
}

const owners = new WeakMap<object, symbol>();
const operations: readonly NativeStreamOperation[] = ['put', 'end', 'on_finalized_text'];

function safely({ record }: { record: () => void }) {
  try {
    record();
  } catch { /* Diagnostic failures never replace native behavior. */ }
}

export function observeNativeStreamer({ streamer, streamerPrototype, capture }: {
  streamer: object; streamerPrototype: object; capture: NativeStreamRecorder | undefined;
}): { restore(): void } {
  const noop = { restore() {} };
  if (capture === undefined) return noop;
  function unavailable({ reason }: { reason: Extract<NativeStreamAvailability, { status: 'unavailable' }>['reason'] }) {
    safely({ record: () => capture?.setNativeStreamAvailability({ availability: { status: 'unavailable', reason } }) });
    return noop;
  }
  if (owners.has(streamer)) return unavailable({ reason: 'already-owned' });
  const originals = new Map<NativeStreamOperation, PropertyDescriptor>();
  try {
    if (Object.getPrototypeOf(streamer) !== streamerPrototype) return unavailable({ reason: 'unsupported-instance' });
    if (!Object.isExtensible(streamer)) return unavailable({ reason: 'not-extensible' });
    for (const operation of operations) {
      const descriptor = Object.getOwnPropertyDescriptor(streamerPrototype, operation);
      if (Object.getOwnPropertyDescriptor(streamer, operation) !== undefined || descriptor === undefined
        || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
        return unavailable({ reason: 'method-descriptor' });
      }
      originals.set(operation, descriptor);
    }
  } catch {
    return unavailable({ reason: 'unsupported-instance' });
  }
  const owner = Symbol('native-stream-owner');
  owners.set(streamer, owner);
  const installed = new Map<NativeStreamOperation, PropertyDescriptor>();
  let ordinal = 0;
  let restored = false;
  function restoreMethods(): 'restored' | 'failed' | 'ownership-lost' {
    let result: 'restored' | 'failed' | 'ownership-lost' = 'restored';
    for (const [operation, descriptor] of installed) {
      try {
        const current = Object.getOwnPropertyDescriptor(streamer, operation);
        if (current?.value !== descriptor.value) {
          switch (result) {
          case 'restored': case 'ownership-lost': result = 'ownership-lost'; break;
          case 'failed': break;
          default: { const _ex: never = result; throw new Error(String(_ex)); }
          }
        } else if (!Reflect.deleteProperty(streamer, operation)) {
          result = 'failed';
        }
      } catch {
        result = 'failed';
      }
    }
    if (owners.get(streamer) === owner) owners.delete(streamer);
    return result;
  }
  try {
    for (const operation of operations) {
      const original: unknown = originals.get(operation)!.value;
      if (typeof original !== 'function') throw new Error('Unsupported native method');
      const descriptor: PropertyDescriptor = {
        configurable: true, enumerable: false, writable: true,
        value: function(this: unknown, ...args: unknown[]) {
          const streamCallOrdinal = ++ordinal;
          safely({ record: () => capture.recordNativeStream({ operation, phase: 'entering', streamCallOrdinal, args }) });
          try {
            const result: unknown = Reflect.apply(original, this, args);
            safely({ record: () => capture.recordNativeStream({ operation, phase: 'returned', streamCallOrdinal, args: [] }) });
            return result;
          } catch (error) {
            safely({ record: () => capture.recordNativeStream({ operation, phase: 'threw', streamCallOrdinal, args: [] }) });
            throw error;
          }
        },
      };
      Object.defineProperty(streamer, operation, descriptor);
      installed.set(operation, descriptor);
    }
  } catch {
    restoreMethods();
    return unavailable({ reason: 'install-failed' });
  }
  safely({ record: () => capture.setNativeStreamAvailability({ availability: { status: 'available', restoration: 'pending' } }) });
  return {
    restore() {
      if (restored) return;
      restored = true;
      const restoration = restoreMethods();
      safely({ record: () => capture.setNativeStreamAvailability({ availability: { status: 'available', restoration } }) });
    },
  };
}

export const TEST_ONLY = {
};
