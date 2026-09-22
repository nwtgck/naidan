import type { WeshIVirtualFileSystem } from '@/features/wesh/types';
import { waitForBlobRead } from '@/utils/blob-view-io';

const READ_CHUNK_SIZE = 64 * 1024;

type VirtualFileContent<T> =
  | { status: 'complete', value: T }
  | { status: 'oversized' };

/**
 * stat.size can be an estimate for generated files. Read actual bytes, stopping
 * at limit + 1 so an exact-limit file is distinguishable from a larger one.
 * This bounds consumption, not the provider's internal rendering allocation.
 */
async function readVirtualContent<T>({ files, path, byteLimit, signal, append, finish }: {
  files: Pick<WeshIVirtualFileSystem, 'open'>,
  path: string,
  byteLimit: number | undefined,
  signal: AbortSignal | undefined,
  append: ({ bytes }: { bytes: Uint8Array<ArrayBuffer> }) => void,
  finish: () => T,
}): Promise<VirtualFileContent<T>> {
  signal?.throwIfAborted();
  if (byteLimit !== undefined && (!Number.isSafeInteger(byteLimit) || byteLimit < 0)) {
    throw new RangeError('Virtual file byte limit must be a non-negative safe integer');
  }
  // Do not abandon open(): a handle returned after cancellation must still be
  // closed by this owner. Cancellation need not wait for an in-flight read.
  const handle = await files.open({
    path, flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }, mode: undefined,
  });
  const outcome = await (async (): Promise<VirtualFileContent<T>> => {
    let position = 0;
    while (true) {
      signal?.throwIfAborted();
      const remaining = byteLimit === undefined ? READ_CHUNK_SIZE : byteLimit - position;
      // Bound before adding the sentinel; MAX_SAFE_INTEGER must not overflow.
      const buffer = new Uint8Array(remaining >= READ_CHUNK_SIZE ? READ_CHUNK_SIZE : remaining + 1);
      let filled = 0;
      while (filled < buffer.byteLength) {
        signal?.throwIfAborted();
        const length = buffer.byteLength - filled;
        const operation = handle.read({ buffer, offset: filled, length });
        const { bytesRead } = await (signal === undefined
          ? operation
          : waitForBlobRead({ operation, signal, timeoutMs: undefined }));
        signal?.throwIfAborted();
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
          throw new Error('Invalid virtual file byte count');
        }
        if (bytesRead === 0) {
          if (filled > 0) append({ bytes: buffer.subarray(0, filled) });
          return { status: 'complete', value: finish() };
        }
        if (bytesRead > Number.MAX_SAFE_INTEGER - position) throw new RangeError('Virtual file is too large');
        position += bytesRead;
        if (byteLimit !== undefined && position > byteLimit) return { status: 'oversized' };
        filled += bytesRead;
      }
      // Coalesce short positive reads into one chunk. A one-byte-at-a-time
      // provider must not cause one 64 KiB buffer/Blob per byte of final output.
      append({ bytes: buffer });
    }
  })().then(
    value => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  // Publish no result until cleanup completes; retain the read failure when
  // close also fails rather than replacing it with a misleading success/EOF.
  try {
    await handle.close();
  } catch (error) {
    switch (outcome.status) {
    case 'fulfilled': throw error;
    case 'rejected': throw new AggregateError([outcome.error, error], 'Virtual file read and close failed');
    default: {
      const _ex: never = outcome;
      throw new Error(`Unhandled virtual read outcome: ${String(_ex)}`);
    }
    }
  }
  switch (outcome.status) {
  case 'fulfilled':
    signal?.throwIfAborted();
    return outcome.value;
  case 'rejected':
    throw outcome.error;
  default: {
    const _ex: never = outcome;
    throw new Error(`Unhandled virtual read outcome: ${String(_ex)}`);
  }
  }
}

/** Decode bytes directly; never create a Blob and consume it again in this realm. */
export function readVirtualFileText({ files, path, byteLimit, signal }: {
  files: Pick<WeshIVirtualFileSystem, 'open'>,
  path: string,
  byteLimit: number | undefined,
  signal: AbortSignal | undefined,
}): Promise<VirtualFileContent<string>> {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  return readVirtualContent({
    files, path, byteLimit, signal,
    append: ({ bytes }) => {
      parts.push(decoder.decode(bytes, { stream: true }));
    },
    finish: () => {
      parts.push(decoder.decode()); return parts.join('');
    },
  });
}

/** Snapshot chunks without a second file-sized merged array or unused buffer tails. */
export function readVirtualFileBlob({ files, path, byteLimit, signal }: {
  files: Pick<WeshIVirtualFileSystem, 'open'>,
  path: string,
  byteLimit: number | undefined,
  signal: AbortSignal | undefined,
}): Promise<VirtualFileContent<Blob>> {
  const parts: Blob[] = [];
  return readVirtualContent({
    files, path, byteLimit, signal,
    append: ({ bytes }) => {
      parts.push(new Blob([bytes]));
    },
    finish: () => new Blob(parts),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  READ_CHUNK_SIZE,
};
