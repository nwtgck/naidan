import { z } from 'zod';
import { createBlobContext, type BlobContext } from '@/utils/blob-view';
import { assertBlobBytes, assertBlobRange, BLOB_VIEW_CHUNK_SIZE, readNativeBlobRange, waitForBlobRead } from '@/utils/blob-view-io';
import { releaseWorkerProxyArgument, workerTransfer, type WorkerTransfer } from '@/utils/worker-transport';

/** Independent, top-level WorkerProxy argument. Never serialize a BlobView or a context. */
export interface WorkerBlobReadHost {
  read({ blob, offset, length }: {
    blob: Blob,
    offset: number,
    length: number,
  }): Promise<WorkerTransfer<Uint8Array<ArrayBuffer>>>,
}

const hostRequestSchema = z.object({
  blob: z.custom<Blob>(value => {
    if (typeof value !== 'object' || value === null) return false;
    try {
      // Native brand check, also valid for another same-agent realm's Blob/File.
      Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!.call(value);
      return true;
    } catch {
      return false;
    }
  }),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  length: z.number().int().nonnegative().max(BLOB_VIEW_CHUNK_SIZE),
});
const hostBytesSchema = z.custom<Uint8Array<ArrayBuffer>>(value =>
  ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
  && Object.prototype.toString.call(value.buffer) === '[object ArrayBuffer]');
const PROBE_TIMEOUT_MS = 5_000;

/** Host realm, one queue per Worker owner. No paths, handle registry, or object URLs. */
export function createWorkerBlobReadHost({ signal }: { signal: AbortSignal }): WorkerBlobReadHost {
  let tail = Promise.resolve();
  return {
    read({ blob, offset, length }) {
      const operation = tail.then(async () => {
        signal.throwIfAborted();
        const validated = hostRequestSchema.parse({ blob, offset, length });
        const bytes = await readNativeBlobRange(validated);
        signal.throwIfAborted();
        return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
      });
      // Logical cancellation must not start another physical read alongside a
      // still-running one. The physical queue and the caller's wait are separate.
      tail = operation.then(() => undefined, () => undefined);
      return waitForBlobRead({ operation, signal, timeoutMs: undefined });
    },
  };
}

/** Construct in the consuming Worker. A per-context probe tests that actual realm. */
export function createWorkerBlobContext({ host }: {
  host: WorkerBlobReadHost | undefined,
}): BlobContext {
  const lifetime = new AbortController();
  const hostOnlyOrigins = new WeakSet<Blob>();
  let mode: 'direct' | 'host' | undefined;
  let probing: Promise<'direct' | 'host'> | undefined;

  async function readHost({ blob, offset, length }: {
    blob: Blob,
    offset: number,
    length: number,
  }): Promise<Uint8Array<ArrayBuffer>> {
    lifetime.signal.throwIfAborted();
    if (host === undefined) throw new Error('Blob read host is unavailable');
    const bytes = hostBytesSchema.parse(await host.read({ blob, offset, length }));
    lifetime.signal.throwIfAborted();
    assertBlobBytes({ bytes, length });
    return bytes;
  }

  async function detectMode(): Promise<'direct' | 'host'> {
    const request = { blob: new Blob([new Uint8Array([13, 78, 0, 255, 10])]), offset: 1, length: 3 };
    function verify({ bytes }: { bytes: Uint8Array }): void {
      if (bytes.length !== 3 || bytes[0] !== 78 || bytes[1] !== 0 || bytes[2] !== 255) {
        throw new Error('Blob read probe returned incorrect bytes');
      }
    }
    let directError: unknown;
    try {
      verify({ bytes: await waitForBlobRead({ operation: readNativeBlobRange(request), signal: lifetime.signal, timeoutMs: PROBE_TIMEOUT_MS }) });
      return 'direct';
    } catch (error) {
      lifetime.signal.throwIfAborted();
      directError = error;
    }
    try {
      verify({ bytes: await waitForBlobRead({ operation: readHost(request), signal: lifetime.signal, timeoutMs: PROBE_TIMEOUT_MS }) });
      return 'host';
    } catch (hostError) {
      lifetime.signal.throwIfAborted();
      throw new AggregateError([directError, hostError], 'Blob reading failed in both Worker and host contexts');
    }
  }

  function getMode(): 'direct' | 'host' | Promise<'direct' | 'host'> {
    if (host === undefined) return 'direct';
    if (mode !== undefined) return mode;
    probing ??= detectMode().then(selected => {
      mode = selected;
      probing = undefined;
      return selected;
    }, error => {
      probing = undefined;
      throw error;
    });
    return probing;
  }

  return createBlobContext({
    reader: {
      native: {
        available({ origin }) {
          lifetime.signal.throwIfAborted();
          if (hostOnlyOrigins.has(origin)) return false;
          const selected = getMode();
          if (typeof selected !== 'string') return selected.then(mode => mode === 'direct' && !hostOnlyOrigins.has(origin));
          return selected === 'direct';
        },
        retryOnNotReadable: host !== undefined,
      },
      async read({ blob, offset, length, origin, signal }) {
        signal.throwIfAborted();
        lifetime.signal.throwIfAborted();
        assertBlobRange({ blob, offset, length });
        const selection = getMode();
        const selectedMode = typeof selection === 'string' ? selection : await selection;
        signal.throwIfAborted();
        lifetime.signal.throwIfAborted();
        if (hostOnlyOrigins.has(origin)) return readHost({ blob, offset, length });
        switch (selectedMode) {
        case 'host':
          return readHost({ blob, offset, length });
        case 'direct':
          try {
            return await readNativeBlobRange({ blob, offset, length });
          } catch (error) {
            signal.throwIfAborted();
            lifetime.signal.throwIfAborted();
            if (host === undefined || typeof error !== 'object' || error === null
              || !('name' in error) || error.name !== 'NotReadableError') throw error;
            // Retry this range only, never writes or entire operations. Slices
            // retain origin identity, so successful recovery also covers siblings.
            try {
              const bytes = await readHost({ blob, offset, length });
              hostOnlyOrigins.add(origin);
              return bytes;
            } catch (hostError) {
              signal.throwIfAborted();
              lifetime.signal.throwIfAborted();
              throw new AggregateError([error, hostError], 'Blob range read failed in both Worker and host contexts');
            }
          }
        default: {
          const _ex: never = selectedMode;
          throw new Error(`Unhandled Blob read mode: ${String(_ex)}`);
        }
        }
      },
    },
    release() {
      lifetime.abort(new DOMException('Worker Blob context disposed', 'AbortError'));
      if (host !== undefined) releaseWorkerProxyArgument({ value: host });
    },
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  PROBE_TIMEOUT_MS,
};
