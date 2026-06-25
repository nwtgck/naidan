import type {
  ZipByteSink,
  ZipCentralDirectoryStore,
  ZipRandomAccessSource,
} from '@/lib/zip-stream';
import type {
  WeshCommandContext,
  WeshFileHandle,
} from '@/services/wesh/types';
import { openFileReadStream } from '@/services/wesh/utils/fs';

/**
 * Wesh adapters for the environment-independent ZIP core.
 *
 * DEPENDENCY DIRECTION — THIS MODULE IS THE BOUNDARY
 * ==================================================
 *
 * This adapter may import both `@/lib/zip-stream` and Wesh filesystem types.
 * The ZIP core must never import this module or any other Wesh module.
 * Main-thread features such as import/export must also use the core directly,
 * never this adapter, or the Wesh implementation can leak into main and
 * standalone bundles.
 *
 * Keep this adapter deliberately thin to preserve Wesh ZIP performance:
 * - write each chunk directly to the supplied Wesh handle;
 * - do not copy chunks;
 * - do not add ReadableStream/WritableStream conversion layers;
 * - do not split chunks into smaller fixed-size pieces;
 * - preserve partial-read and partial-write handling inside this boundary.
 */

function assertProgress({
  operation,
  progress,
  remaining,
}: {
  operation: string,
  progress: number,
  remaining: number,
}): void {
  if (!Number.isSafeInteger(progress) || progress <= 0 || progress > remaining) {
    throw new Error(`${operation} returned invalid progress: ${progress}`);
  }
}

function assertReadRange({
  offset,
  length,
  size,
}: {
  offset: number,
  length: number,
  size: number,
}): void {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset > size
    || length > size - offset
  ) {
    throw new Error('ZIP read range is outside the archive');
  }
}

export function createWeshZipByteSink({
  handle,
}: {
  handle: WeshFileHandle,
}): ZipByteSink {
  return {
    async write({ chunk }) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write({
          buffer: chunk,
          offset,
          length: chunk.byteLength - offset,
        });
        assertProgress({
          operation: 'ZIP output write',
          progress: bytesWritten,
          remaining: chunk.byteLength - offset,
        });
        offset += bytesWritten;
      }
    },
  };
}

export function createWeshZipCentralDirectoryStore({
  files,
  path,
  handle,
}: {
  files: WeshCommandContext['files'],
  path: string,
  handle: WeshFileHandle,
}): ZipCentralDirectoryStore {
  const sink = createWeshZipByteSink({ handle });
  let finalized = false;
  let disposed = false;

  async function closeHandle(): Promise<void> {
    if (finalized) {
      return;
    }
    await handle.close();
    finalized = true;
  }

  return {
    async write({ chunk }) {
      if (finalized || disposed) {
        throw new Error('Wesh ZIP central directory store is not writable');
      }
      await sink.write({ chunk });
    },
    async finalize() {
      if (disposed) {
        throw new Error('Wesh ZIP central directory store is disposed');
      }
      await closeHandle();
    },
    async openStream() {
      if (!finalized || disposed) {
        throw new Error('Wesh ZIP central directory store is not readable');
      }
      return openFileReadStream({ files, path });
    },
    async dispose() {
      if (disposed) {
        return;
      }
      let closeError: unknown;
      try {
        await closeHandle();
      } catch (error: unknown) {
        closeError = error;
      }
      try {
        await files.unlink({ path });
      } catch {
        // Cleanup is best-effort and must not hide the primary ZIP result.
      }
      if (closeError !== undefined) {
        throw closeError;
      }
      disposed = true;
    },
  };
}

export async function createWeshZipRandomAccessSource({
  handle,
}: {
  handle: WeshFileHandle,
}): Promise<ZipRandomAccessSource> {
  let stat: Awaited<ReturnType<WeshFileHandle['stat']>>;
  try {
    stat = await handle.stat();
  } catch (error: unknown) {
    try {
      await handle.close();
    } catch (closeError: unknown) {
      throw new AggregateError(
        [error, closeError],
        'Failed to inspect and close the Wesh ZIP source',
      );
    }
    throw error;
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    try {
      await handle.close();
    } catch {
      // Preserve the invalid-stat error as the primary failure.
    }
    throw new Error(`ZIP source returned an invalid size: ${stat.size}`);
  }
  return {
    size: stat.size,
    async read({ offset, length }) {
      assertReadRange({ offset, length, size: stat.size });
      const output = new Uint8Array(length);
      let totalRead = 0;
      while (totalRead < length) {
        const { bytesRead } = await handle.read({
          buffer: output,
          offset: totalRead,
          length: length - totalRead,
          position: offset + totalRead,
        });
        assertProgress({
          operation: 'ZIP input read',
          progress: bytesRead,
          remaining: length - totalRead,
        });
        totalRead += bytesRead;
      }
      return output;
    },
    async close() {
      await handle.close();
    },
  };
}
