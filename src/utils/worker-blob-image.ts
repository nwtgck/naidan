import { z } from 'zod';
import { blobImageInput, decodeNativeBlobImage, isBlobImageDecodeFailure, parseBlobImagePixels, type BlobImageDecoder, type BlobImageLimits, type BlobImagePixels } from './blob-image';
import { waitForBlobRead } from './blob-view-io';
import { releaseWorkerProxyArgument, workerTransfer, type WorkerTransfer } from './worker-transport';

/** Top-level reverse proxy. Transfer RGBA bytes, never ImageBitmap or canvas state. */
export interface WorkerBlobImageHost {
  decode({ blob }: { blob: Blob }): Promise<WorkerTransfer<BlobImagePixels>>,
}

const requestSchema = z.object({ blob: z.custom<Blob>(value => {
  try {
    Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!.call(value);
    return true;
  } catch {
    return false;
  }
}) }).strict();
const PROBE_TIMEOUT_MS = 5_000;
// A complete, non-interlaced 1x1 opaque-red RGBA PNG, with CRCs. No URL or fetch.
const PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

/** Host owner bounds each decoded image and serializes physical decoding requests. */
export function createWorkerBlobImageHost({ limits: suppliedLimits, signal }: {
  limits: BlobImageLimits, signal: AbortSignal,
}): WorkerBlobImageHost {
  const limits = { ...suppliedLimits };
  let tail = Promise.resolve();
  return {
    decode({ blob }) {
      const operation = tail.then(async () => {
        signal.throwIfAborted();
        const request = requestSchema.parse({ blob });
        const pixels = parseBlobImagePixels({ value: await decodeNativeBlobImage({ ...request, limits, signal }), limits });
        signal.throwIfAborted();
        return workerTransfer({ value: pixels, transferables: [pixels.rgba.buffer] });
      });
      tail = operation.then(() => {}, () => {});
      return waitForBlobRead({ operation, signal, timeoutMs: undefined });
    },
  };
}

/** A lifetime separate from the byte reader; byte-read success is not decoder support. */
export function createWorkerBlobImageDecoder({ host, limits: suppliedLimits }: {
  host: WorkerBlobImageHost | undefined, limits: BlobImageLimits,
}): BlobImageDecoder {
  const limits = { ...suppliedLimits };
  const lifetime = new AbortController();
  let mode: Promise<'direct' | 'host'> | undefined;
  const hostOnly = new WeakSet<Blob>();

  async function onHost({ blob, signal }: { blob: Blob, signal: AbortSignal }): Promise<BlobImagePixels> {
    signal.throwIfAborted();
    if (host === undefined) throw new Error('Image decode host is unavailable');
    const value = await waitForBlobRead({ operation: host.decode({ blob }), signal, timeoutMs: undefined });
    return parseBlobImagePixels({ value, limits });
  }

  async function probe({ location }: { location: 'direct' | 'host' }): Promise<void> {
    const deadline = new AbortController();
    const onAbort = () => deadline.abort(lifetime.signal.reason);
    if (lifetime.signal.aborted) onAbort();
    else lifetime.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => deadline.abort(new DOMException('Image decode probe timed out', 'TimeoutError')), PROBE_TIMEOUT_MS);
    try {
      deadline.signal.throwIfAborted();
      const blob = new Blob([Uint8Array.from(atob(PROBE_PNG), value => value.charCodeAt(0))], { type: 'image/png' });
      const request = { blob, signal: deadline.signal };
      const image = await waitForBlobRead({ operation: (() => {
        switch (location) {
        case 'direct': return decodeNativeBlobImage({ ...request, limits });
        case 'host': return onHost(request);
        default: { const _ex: never = location; throw new Error(`Unknown image probe path: ${String(_ex)}`); }
        }
      })(), signal: deadline.signal, timeoutMs: undefined });
      deadline.signal.throwIfAborted();
      const pixels = parseBlobImagePixels({ value: image, limits });
      if (pixels.width !== 1 || pixels.height !== 1 || ![255, 0, 0, 255].every((byte, index) => pixels.rgba[index] === byte)) {
        throw new Error('Image probe returned incorrect pixels');
      }
    } finally {
      clearTimeout(timer);
      lifetime.signal.removeEventListener('abort', onAbort);
      deadline.abort(new DOMException('Image probe finished', 'AbortError'));
    }
  }

  async function detect(): Promise<'direct' | 'host'> {
    let directError: unknown;
    try {
      await probe({ location: 'direct' }); return 'direct';
    } catch (error) {
      lifetime.signal.throwIfAborted(); directError = error;
    }
    try {
      await probe({ location: 'host' }); return 'host';
    } catch (error) {
      lifetime.signal.throwIfAborted();
      throw new AggregateError([directError, error], 'Image decoding failed in both Worker and host contexts');
    }
  }

  async function select(): Promise<'direct' | 'host'> {
    // Tiny caller limits might exclude even the 70-byte PNG. In that case use
    // the actual image for read-only recovery, without caching realm capability.
    if (host === undefined || limits.maxBytes < 70) return 'direct';
    mode ??= detect();
    const current = mode;
    try {
      return await current;
    } catch (error) {
      if (mode === current) mode = undefined; throw error;
    }
  }

  async function decode({ blob, signal }: { blob: Blob, signal: AbortSignal }): Promise<BlobImagePixels> {
    const selected = await waitForBlobRead({ operation: select(), signal, timeoutMs: undefined });
    if (hostOnly.has(blob)) return onHost({ blob, signal });
    switch (selected) {
    case 'host': return onHost({ blob, signal });
    case 'direct':
      try {
        return await decodeNativeBlobImage({ blob, signal, limits });
      } catch (error) {
        signal.throwIfAborted();
        // A real format/File can fail after the PNG succeeds. Retry only this
        // image; do not mark every image unsupported or bypass security/limits.
        if (host === undefined || !isBlobImageDecodeFailure({ error })) throw error;
        try {
          const pixels = await onHost({ blob, signal });
          hostOnly.add(blob);
          return pixels;
        } catch (hostError) {
          signal.throwIfAborted();
          throw new AggregateError([error, hostError], 'Image decoding failed in both Worker and host contexts');
        }
      }
    default: { const _ex: never = selected; throw new Error(`Unknown image decoding path: ${String(_ex)}`); }
    }
  }

  return {
    async decode({ blob, signal }) {
      lifetime.signal.throwIfAborted();
      signal?.throwIfAborted();
      const input = blobImageInput({ blob, limits });
      const operation = new AbortController();
      const signals = [lifetime.signal, signal].filter(item => item !== undefined);
      const listeners = signals.map(item => {
        const onAbort = () => operation.abort(item.reason);
        if (item.aborted) onAbort(); else item.addEventListener('abort', onAbort, { once: true });
        return { signal: item, onAbort };
      });
      try {
        return await waitForBlobRead({ operation: decode({ blob: input, signal: operation.signal }), signal: operation.signal, timeoutMs: undefined });
      } finally {
        for (const item of listeners) item.signal.removeEventListener('abort', item.onAbort);
        operation.abort(new DOMException('Image read finished', 'AbortError'));
      }
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort(new DOMException('Image decoder disposed', 'AbortError'));
      if (host !== undefined) releaseWorkerProxyArgument({ value: host });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  PROBE_TIMEOUT_MS,
  PROBE_PNG,
};
