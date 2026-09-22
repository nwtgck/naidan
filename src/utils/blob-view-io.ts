/** Bound each physical byte request, not the size of a caller's complete result. */
export const BLOB_VIEW_CHUNK_SIZE = 256 * 1024;

export interface BlobRangeReader {
  /** Internal local optimization only. Omit for custom readers whose behavior must not be bypassed. */
  native?: {
    available({ origin }: { origin: Blob }): boolean | Promise<boolean>,
    retryOnNotReadable: boolean,
  },
  /** A fresh, exactly-sized, exclusively owned ArrayBuffer-backed view is required. */
  read({ blob, offset, length, origin, signal }: {
    blob: Blob,
    offset: number,
    length: number,
    origin: Blob,
    signal: AbortSignal,
  }): Promise<Uint8Array<ArrayBuffer>>,
}

export function assertBlobRange({ blob, offset, length }: {
  blob: Blob,
  offset: number,
  length: number,
}): void {
  if (!Number.isSafeInteger(blob.size) || blob.size < 0
    || !Number.isSafeInteger(offset) || offset < 0 || offset > blob.size
    || !Number.isSafeInteger(length) || length < 0 || length > blob.size - offset) {
    throw new RangeError('Blob read range is outside the snapshot');
  }
}

export function assertBlobBytes({ bytes, length }: {
  bytes: Uint8Array<ArrayBuffer>,
  length: number,
}): void {
  if (!ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== '[object Uint8Array]'
    || Object.prototype.toString.call(bytes.buffer) !== '[object ArrayBuffer]'
    || bytes.byteLength !== length || bytes.byteOffset !== 0 || bytes.buffer.byteLength !== length) {
    throw new Error('Blob read must return an exact, exclusively owned byte buffer');
  }
}

export async function readNativeBlobRange({ blob, offset, length }: {
  blob: Blob,
  offset: number,
  length: number,
}): Promise<Uint8Array<ArrayBuffer>> {
  assertBlobRange({ blob, offset, length });
  if (length === 0) return new Uint8Array(0);
  const source = offset === 0 && length === blob.size ? blob : blob.slice(offset, offset + length);
  const bytes = new Uint8Array(await source.arrayBuffer());
  assertBlobBytes({ bytes, length });
  return bytes;
}

/** Cancel a logical wait, not an already-started browser operation. Observe late rejections. */
export async function waitForBlobRead<T>({ operation, signal, timeoutMs }: {
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number | undefined,
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        if (timeoutMs !== undefined) {
          timeout = setTimeout(() => reject(new DOMException('Blob read probe timed out', 'TimeoutError')), timeoutMs);
        }
      }),
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
