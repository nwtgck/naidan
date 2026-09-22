import { assertBlobBytes, BLOB_VIEW_CHUNK_SIZE, readNativeBlobRange, waitForBlobRead, type BlobRangeReader } from './blob-view-io';

/** Local reading interface, deliberately not assignable to a native Blob. */
export interface BlobView {
  readonly size: number,
  readonly type: string,
  slice({ start, end, contentType }: { start?: number, end?: number, contentType?: string }): BlobView,
  text({ signal }?: { signal?: AbortSignal }): Promise<string>,
  arrayBuffer({ signal }?: { signal?: AbortSignal }): Promise<ArrayBuffer>,
  bytes({ signal }?: { signal?: AbortSignal }): Promise<Uint8Array<ArrayBuffer>>,
  stream({ signal }?: { signal?: AbortSignal }): ReadableStream<Uint8Array<ArrayBuffer>>,
}

export interface BlobContext {
  fromNative({ blob }: { blob: Blob }): BlobView,
  fromParts({ parts, type, endings }: {
    parts: readonly (BlobPart | BlobView)[],
    type?: string,
    endings?: EndingType,
  }): BlobView,
  dispose(): void,
}

// Only native snapshots live here: no ports, URLs, registries on the host, or byte caches.
const snapshots = new WeakMap<object, Blob>();

function isBlobView(value: unknown): value is BlobView {
  return typeof value === 'object' && value !== null && snapshots.has(value);
}

function nativeSnapshot({ blob }: { blob: BlobView }): Blob {
  const snapshot = snapshots.get(blob);
  if (snapshot === undefined) throw new TypeError('Expected a BlobView created by a BlobContext');
  return snapshot;
}

function nativePart({ part }: { part: BlobPart | BlobView }): BlobPart {
  if (isBlobView(part)) return nativeSnapshot({ blob: part });
  if (typeof part === 'string' || ArrayBuffer.isView(part)
    || Object.prototype.toString.call(part) === '[object ArrayBuffer]') return part;
  // Do not silently stringify a spread/copied view as "[object Object]".
  try {
    Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!.call(part);
    return part;
  } catch {
    throw new TypeError('Blob parts must be native data or an original BlobView');
  }
}

/** Transport/interop boundary only. This does not make native reads safe in the receiving realm. */
export function blobForTransport({ blob }: { blob: BlobView }): Blob {
  return nativeSnapshot({ blob });
}

export function createNativeBlobContext(): BlobContext {
  return createBlobContext({ reader: {
    read: readNativeBlobRange,
    native: { available: () => true, retryOnNotReadable: false },
  }, release: undefined });
}

/** A context owns reading lifetime; views/slices borrow it and never release it individually. */
export function createBlobContext({ reader, release }: {
  reader: BlobRangeReader,
  release: (() => void) | undefined,
}): BlobContext {
  const lifetime = new AbortController();
  const bulkReads = new Set<() => void>();

  function checkActive({ signal }: { signal: AbortSignal | undefined }): void {
    lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
  }

  function canRetry({ error }: { error: unknown }): boolean {
    return reader.native?.retryOnNotReadable === true && typeof error === 'object'
      && error !== null && 'name' in error && error.name === 'NotReadableError';
  }

  // A native bulk operation is not cancellable. Only its wait is wrapped; do
  // not turn it into a range stream just to preserve the owner's lifetime.
  // Pending bulk waits share the context registry, avoiding a lifetime event
  // listener/AbortController for every small, directly readable slice.
  function ownRead<T>({ operation, signal }: { operation: Promise<T>, signal: AbortSignal | undefined }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(lifetime.signal.aborted ? lifetime.signal.reason : signal?.reason);
      };
      const cleanup = () => {
        bulkReads.delete(abort);
        signal?.removeEventListener('abort', abort);
      };
      operation.then(value => {
        cleanup();
        try {
          checkActive({ signal }); resolve(value);
        } catch (error) {
          reject(error);
        }
      }, error => {
        cleanup();
        try {
          checkActive({ signal }); reject(error);
        } catch (aborted) {
          reject(aborted);
        }
      });
      if (lifetime.signal.aborted || signal?.aborted) abort();
      else {
        bulkReads.add(abort);
        signal?.addEventListener('abort', abort, { once: true });
      }
    });
  }

  function fromSnapshot({ blob, origin }: { blob: Blob, origin: Blob }): BlobView {
    lifetime.signal.throwIfAborted();
    if (!Number.isSafeInteger(blob.size) || blob.size < 0) throw new RangeError('Invalid Blob snapshot size');
    function bulk<T>({ native, fallback, signal }: {
      native: () => Promise<T>,
      fallback: () => Promise<T>,
      signal: AbortSignal | undefined,
    }): Promise<T> {
      function run({ direct }: { direct: boolean }): Promise<T> {
        checkActive({ signal });
        if (!direct) return fallback();
        let operation: Promise<T>;
        try {
          operation = native();
        } catch (error) {
          operation = Promise.reject(error);
        }
        if (!reader.native?.retryOnNotReadable) return operation;
        return operation.catch(error => {
          checkActive({ signal });
          if (!canRetry({ error })) throw error;
          // A File can differ from the in-memory probe. Retrying the same
          // snapshot through the range reader preserves per-origin recovery.
          return fallback().catch(fallbackError => {
            checkActive({ signal });
            throw new AggregateError([error, fallbackError], 'Native Blob operation and range recovery failed');
          });
        });
      }
      try {
        checkActive({ signal });
        // Empty reads still respect cancellation, but never need the bridge probe.
        const available = blob.size === 0 ? true : reader.native?.available({ origin }) ?? false;
        const operation = typeof available === 'boolean' ? run({ direct: available }) : available.then(direct => run({ direct }));
        return ownRead({ operation, signal });
      } catch (error) {
        return Promise.reject(error);
      }
    }

    function stream({ signal, rangesOnly }: { signal: AbortSignal | undefined, rangesOnly: boolean }): ReadableStream<Uint8Array<ArrayBuffer>> {
      const pending = new AbortController();
      const signals = [lifetime.signal, signal].filter(signal => signal !== undefined);
      let position = 0;
      let stopped = false;
      let initialized = rangesOnly;
      let nativeReader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
      let cleanup: Promise<void> | undefined;
      let nativeFailure: { error: unknown } | undefined;
      const isStopped = () => stopped;
      const listeners: Array<{ signal: AbortSignal, onAbort: () => void }> = [];
      function stop(): void {
        stopped = true;
        for (const { signal, onAbort } of listeners) signal.removeEventListener('abort', onAbort);
        listeners.length = 0;
      }
      function closeNative({ cancel, reason }: { cancel: boolean, reason: unknown }): Promise<void> {
        if (cleanup !== undefined) return cleanup;
        const owned = nativeReader;
        nativeReader = undefined;
        if (owned === undefined) return Promise.resolve();
        cleanup = (async () => {
          try {
            if (cancel) await owned.cancel(reason);
          } finally {
            owned.releaseLock();
          }
        })();
        return cleanup;
      }
      return new ReadableStream({
        type: 'bytes',
        start(controller) {
          for (const signal of signals) {
            const onAbort = () => {
              if (isStopped()) return;
              stop();
              pending.abort(signal.reason);
              controller.error(signal.reason);
              void closeNative({ cancel: true, reason: signal.reason }).catch(() => {});
            };
            if (signal.aborted) {
              onAbort(); return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            listeners.push({ signal, onAbort });
          }
          if (blob.size === 0) {
            controller.close(); stop();
          }
        },
        async pull(controller) {
          if (isStopped()) return;
          try {
            if (!initialized) {
              const availability = reader.native?.available({ origin }) ?? false;
              const available = typeof availability === 'boolean' ? availability : await availability;
              if (isStopped()) return;
              initialized = true;
              if (available) {
                try {
                  nativeReader = blob.stream().getReader();
                } catch (error) {
                  if (!canRetry({ error })) throw error;
                  nativeFailure = { error };
                }
              }
            }
            if (isStopped()) {
              await closeNative({ cancel: true, reason: pending.signal.reason });
              return;
            }
            if (nativeReader !== undefined) {
              // Forward native chunks without slice/arrayBuffer, re-chunking or
              // buffer copies. One local byte-stream adapter preserves BYOB and
              // cancellation even when the native source has no BYOB support.
              while (nativeReader !== undefined) {
                let result: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;
                try {
                  result = await nativeReader.read();
                } catch (error) {
                  if (isStopped()) return;
                  if (!canRetry({ error }) || position === blob.size) throw error;
                  nativeFailure = { error };
                  await closeNative({ cancel: true, reason: error }).catch(() => {});
                  break;
                }
                if (isStopped()) return;
                if (result.done) {
                  if (position !== blob.size) throw new Error('Incomplete native Blob stream');
                  await closeNative({ cancel: false, reason: undefined });
                  if (isStopped()) return;
                  controller.close(); controller.byobRequest?.respond(0); stop();
                  return;
                }
                const bytes = result.value;
                if (!ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== '[object Uint8Array]'
                  || Object.prototype.toString.call(bytes.buffer) !== '[object ArrayBuffer]'
                  || bytes.byteLength > blob.size - position) throw new Error('Invalid native Blob stream chunk');
                if (bytes.byteLength === 0) continue;
                position += bytes.byteLength;
                controller.enqueue(bytes);
                return;
              }
            }
            if (isStopped()) return;
            // If a native stream failed after publishing a prefix, resume only
            // the unread range. Never replay already delivered bytes.
            const length = Math.min(BLOB_VIEW_CHUNK_SIZE, blob.size - position, controller.byobRequest?.view?.byteLength ?? BLOB_VIEW_CHUNK_SIZE);
            const bytes = await waitForBlobRead({
              operation: reader.read({ blob, offset: position, length, origin, signal: pending.signal }),
              signal: pending.signal, timeoutMs: undefined,
            });
            if (isStopped()) return;
            assertBlobBytes({ bytes, length });
            position += length;
            if (length !== 0) controller.enqueue(bytes);
            if (position === blob.size) {
              controller.close(); controller.byobRequest?.respond(0); stop();
            }
          } catch (error) {
            if (!isStopped()) {
              const failure = nativeFailure === undefined ? error
                : new AggregateError([nativeFailure.error, error], 'Native Blob stream and range recovery failed');
              stop(); pending.abort(failure); controller.error(failure);
              void closeNative({ cancel: true, reason: error }).catch(() => {});
            }
          }
        },
        cancel(reason) {
          stop(); pending.abort(reason);
          return closeNative({ cancel: true, reason });
        },
      }, { highWaterMark: 0 });
    }

    async function textFromRanges({ signal }: { signal: AbortSignal | undefined }): Promise<string> {
      const streamReader = stream({ signal, rangesOnly: true }).getReader();
      const decoder = new TextDecoder();
      const parts: string[] = [];
      try {
        while (true) {
          const result = await streamReader.read();
          if (result.done) break;
          parts.push(decoder.decode(result.value, { stream: true }));
        }
        lifetime.signal.throwIfAborted();
        signal?.throwIfAborted();
        parts.push(decoder.decode());
        return parts.join('');
      } finally {
        await streamReader.cancel().catch(() => undefined);
        streamReader.releaseLock();
      }
    }
    async function bytesFromRanges({ signal }: { signal: AbortSignal | undefined }): Promise<Uint8Array<ArrayBuffer>> {
      lifetime.signal.throwIfAborted();
      signal?.throwIfAborted();
      // Allocation failures must happen before creating a stream with listeners.
      const combined = blob.size > BLOB_VIEW_CHUNK_SIZE ? new Uint8Array(blob.size) : undefined;
      const streamReader = stream({ signal, rangesOnly: true }).getReader();
      let single = new Uint8Array(0);
      let position = 0;
      try {
        while (true) {
          const result = await streamReader.read();
          if (result.done) break;
          if (combined === undefined) single = result.value;
          else combined.set(result.value, position);
          position += result.value.byteLength;
        }
        lifetime.signal.throwIfAborted();
        signal?.throwIfAborted();
        if (position !== blob.size) throw new Error('Incomplete BlobView read');
        return combined ?? single;
      } finally {
        await streamReader.cancel().catch(() => undefined);
        streamReader.releaseLock();
      }
    }

    const view: BlobView = {
      size: blob.size,
      type: blob.type,
      slice({ start, end, contentType }) {
        lifetime.signal.throwIfAborted();
        // Delegate native index conversion and MIME normalization, but never leak
        // an unwrapped slice into the next reading operation.
        return fromSnapshot({ blob: blob.slice(start, end, contentType), origin });
      },
      stream({ signal } = {}) {
        return stream({ signal, rangesOnly: false });
      },
      text({ signal } = {}) {
        return bulk({ native: () => blob.size === 0 ? Promise.resolve('') : blob.text(), fallback: () => textFromRanges({ signal }), signal });
      },
      bytes({ signal } = {}) {
        return bulk({ native: async () => {
          if (blob.size === 0) return new Uint8Array(0);
          const bytes = typeof blob.bytes === 'function' ? await blob.bytes() : new Uint8Array(await blob.arrayBuffer());
          assertBlobBytes({ bytes, length: blob.size });
          return bytes;
        }, fallback: () => bytesFromRanges({ signal }), signal });
      },
      arrayBuffer({ signal } = {}) {
        return bulk({ native: async () => {
          if (blob.size === 0) return new ArrayBuffer(0);
          const buffer = await blob.arrayBuffer();
          if (Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]' || buffer.byteLength !== blob.size) {
            throw new Error('Incomplete native Blob buffer');
          }
          return buffer;
        }, fallback: async () => (await bytesFromRanges({ signal })).buffer, signal });
      },
    };
    snapshots.set(view, blob);
    return Object.freeze(view);
  }

  return {
    fromNative({ blob }) {
      return fromSnapshot({ blob, origin: blob });
    },
    fromParts({ parts, type, endings }) {
      lifetime.signal.throwIfAborted();
      const blob = new Blob(parts.map(part => nativePart({ part })), { type, endings });
      return fromSnapshot({ blob, origin: blob });
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort(new DOMException('Blob context disposed', 'AbortError'));
      for (const abort of bulkReads) abort();
      release?.();
    },
  };
}

export interface BlobObjectURL {
  readonly url: string,
  revoke(): void,
}

export interface BlobURLScope {
  createObjectURL({ blob }: { blob: Blob | BlobView }): BlobObjectURL,
  dispose(): void,
}

/** Create in the displaying realm. URL ownership is independent of reading-context lifetime. */
export function createBlobURLScope(): BlobURLScope {
  const leases = new Set<BlobObjectURL>();
  let disposed = false;
  return {
    createObjectURL({ blob }) {
      if (disposed) throw new Error('Blob URL scope is disposed');
      const url = URL.createObjectURL(isBlobView(blob) ? nativeSnapshot({ blob }) : blob);
      const revokeNative = URL.revokeObjectURL.bind(URL);
      const lease: BlobObjectURL = Object.freeze({
        url,
        revoke() {
          if (!leases.delete(lease)) return;
          revokeNative(url);
        },
      });
      leases.add(lease);
      return lease;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      for (const lease of leases) {
        try {
          lease.revoke();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length !== 0) throw new AggregateError(errors, 'Failed to revoke Blob URLs');
    },
  };
}

/** Use the safe byte stream, not Response(nativeBlob), which would bypass the reader. */
export function createBlobResponse({ blob, init, signal }: {
  blob: BlobView,
  init: ResponseInit | undefined,
  signal: AbortSignal | undefined,
}): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type') && blob.type !== '') headers.set('Content-Type', blob.type);
  const body = blob.stream({ signal });
  try {
    return new Response(body, { ...init, headers });
  } catch (error) {
    void body.cancel(error).catch(() => undefined);
    throw error;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
