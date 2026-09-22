import type { BlobView } from './blob-view';
import { assertBlobBytes } from './blob-view-io';
import type { ZipRandomAccessSource } from './zip-stream';

/** A byte source failure is not evidence that the archive format is invalid. */
export class BlobViewZipReadError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super('Unable to read ZIP source bytes', { cause });
    this.name = 'BlobViewZipReadError';
  }
}

/** Keep the ZIP core independent of BlobView, Worker transport, and file ownership. */
export function createBlobViewZipSource({ blob, signal }: {
  blob: BlobView,
  signal: AbortSignal | undefined,
}): ZipRandomAccessSource {
  const lifetime = new AbortController();
  const onAbort = () => lifetime.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    size: blob.size,
    async read({ offset, length }) {
      lifetime.signal.throwIfAborted();
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > blob.size
        || !Number.isSafeInteger(length) || length < 0 || length > blob.size - offset) {
        throw new RangeError('ZIP source read is outside the BlobView');
      }
      try {
        const bytes = await blob.slice({ start: offset, end: offset + length }).bytes({ signal: lifetime.signal });
        lifetime.signal.throwIfAborted();
        assertBlobBytes({ bytes, length });
        return bytes;
      } catch (cause) {
        lifetime.signal.throwIfAborted();
        throw new BlobViewZipReadError({ cause });
      }
    },
    async close() {
      signal?.removeEventListener('abort', onAbort);
      // The source owns only its reads, never the shared context or its sibling views.
      lifetime.abort(new DOMException('ZIP source closed', 'AbortError'));
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
