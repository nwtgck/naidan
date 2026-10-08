export const MAX_OFFSET = (1n << 48n) - 1n;
export const CAPSULE_BYTES = 65536;
export const RECORD_OVERHEAD_BYTES = 38;
export const RECORD_PLAINTEXT_BYTES = CAPSULE_BYTES - RECORD_OVERHEAD_BYTES;
export const SEGMENT_BYTES = 16384;
export const RECEIVE_WINDOW = 65536n;
export const RETAINED_STREAMS = 32;
export function requireValue({ condition, message }: {
    condition: unknown;
    message: string;
}): void {
  if (!condition)
    throw new Error(message);
}
export function ownBytes({ bytes, maxBytes }: {
    bytes: Uint8Array;
    maxBytes: number;
}): Uint8Array<ArrayBuffer> {
  requireValue({
    condition: bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer,
    message: 'A non-shared Uint8Array is required',
  });
  requireValue({ condition: bytes.byteLength <= maxBytes, message: 'Input exceeds byte limit' });
  return new Uint8Array(bytes);
}
export function joinBytes({ parts }: {
    parts: readonly Uint8Array[];
}): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
export function ascii({ text }: {
    text: string;
}): Uint8Array<ArrayBuffer> {
  requireValue({ condition: /^[\x20-\x7e]*$/.test(text), message: 'ASCII required' });
  return new TextEncoder().encode(text);
}
export function u64({ value }: {
    value: bigint;
}): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, false);
  return result;
}
export function fields({ parts }: {
    parts: readonly Uint8Array[];
}): Uint8Array<ArrayBuffer> {
  requireValue({ condition: parts.length <= 65535 && parts.every(p => p.length <= 65535), message: 'Field limit' });
  const result = new Uint8Array(2 + parts.reduce((n, part) => n + 2 + part.length, 0));
  const view = new DataView(result.buffer);
  view.setUint16(0, parts.length, false);
  let at = 2;
  for (const part of parts) {
    view.setUint16(at, part.length, false);
    result.set(part, at + 2);
    at += 2 + part.length;
  }
  return result;
}
export function equalBytes({ left, right }: {
    left: Uint8Array;
    right: Uint8Array;
}): boolean {
  // Used only for public identities / framing. Secret MACs use SubtleCrypto.verify.
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
export function bitHas({ bitmap, id }: {
    bitmap: Uint8Array;
    id: number;
}): boolean {
  return ((bitmap[id >> 3] ?? 0) & (1 << (id & 7))) !== 0;
}
export function bitSet({ bitmap, id }: {
    bitmap: Uint8Array;
    id: number;
}): void {
  requireValue({ condition: id >= 0 && id <= 65535 && Number.isInteger(id), message: 'Stream ID' });
  bitmap[id >> 3] = (bitmap[id >> 3] ?? 0) | (1 << (id & 7));
}
export class Pulse {
  private internalRevision = 0;
  private internalListeners = new Set<() => void>();
  get revision(): number {
    return this.internalRevision;
  }
  fire(): void {
    this.internalRevision++; for (const wake of [...this.internalListeners])
      wake();
  }
  wait({ revision, signal }: {
        revision: number;
        signal: AbortSignal | undefined;
    }): Promise<void> {
    if (signal?.aborted)
      return Promise.reject(signal.reason);
    if (revision !== this.internalRevision)
      return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        this.internalListeners.delete(wake); signal?.removeEventListener('abort', abort);
      };
      const wake = () => {
        finish(); resolve();
      };
      const abort = () => {
        finish(); reject(signal?.reason);
      };
      this.internalListeners.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
      if (revision !== this.internalRevision)
        wake();
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
