import { runWithStorageBinaryObjectReadHandleClose } from '@/00-storage/service/binary-object-io';
import type { StorageFileHandle } from './types';

const DEFAULT_STREAM_CHUNK_SIZE = 1024 * 1024;

export async function readStorageFileText({ fileHandle }: {
  fileHandle: StorageFileHandle;
}): Promise<string> {
  const readable = await fileHandle.openReadable({ mimeType: 'text/plain' });
  return await runWithStorageBinaryObjectReadHandleClose({
    handle: readable,
    operation: async () => await new Response(readable.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    })).text(),
  });
}

export async function writeStorageFileText({ fileHandle, value }: {
  fileHandle: StorageFileHandle;
  value: string;
}): Promise<void> {
  const writable = await fileHandle.createWritable({ keepExistingData: false });
  try {
    await writable.write({
      position: 0,
      data: new TextEncoder().encode(value),
    });
    await writable.close();
  } catch (error: unknown) {
    const abortFailure = await captureCleanupFailure({
      cleanup: async () => await writable.abort({ reason: error }),
    });
    throwWithCleanupFailures({
      cleanupFailures: abortFailure === undefined ? [] : [abortFailure],
      message: 'Storage text write and writable abort both failed',
      primaryFailure: error,
    });
  }
}

export async function writeStorageReadableStream({
  fileHandle,
  source,
  expectedSize,
  signal,
  onBytesWritten,
}: {
  fileHandle: StorageFileHandle;
  source: ReadableStream<Uint8Array>;
  expectedSize: number | undefined;
  signal: AbortSignal | undefined;
  onBytesWritten: (({ byteLength }: { byteLength: number }) => void) | undefined;
}): Promise<void> {
  const writable = await fileHandle.createWritable({ keepExistingData: false });
  const reader = source.getReader();
  let position = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const result = await reader.read();
      if (result.done) {
        break;
      }
      for (let offset = 0; offset < result.value.byteLength; offset += DEFAULT_STREAM_CHUNK_SIZE) {
        const chunk = result.value.subarray(
          offset,
          Math.min(offset + DEFAULT_STREAM_CHUNK_SIZE, result.value.byteLength),
        );
        await writable.write({ position, data: chunk });
        position += chunk.byteLength;
        onBytesWritten?.({ byteLength: chunk.byteLength });
      }
    }
    if (expectedSize !== undefined && position !== expectedSize) {
      throw new Error(`Storage file size mismatch: expected ${expectedSize}, wrote ${position}`);
    }
    await writable.close();
  } catch (error: unknown) {
    const cancelFailure = await captureCleanupFailure({
      cleanup: async () => await reader.cancel(error),
    });
    const abortFailure = await captureCleanupFailure({
      cleanup: async () => await writable.abort({ reason: error }),
    });
    throwWithCleanupFailures({
      cleanupFailures: [cancelFailure, abortFailure].filter(isCapturedFailure),
      message: 'Storage stream write and cleanup encountered multiple failures',
      primaryFailure: error,
    });
  } finally {
    reader.releaseLock();
  }
}

type CapturedFailure = {
  readonly cause: unknown;
};

async function captureCleanupFailure({ cleanup }: {
  cleanup: () => Promise<void>;
}): Promise<CapturedFailure | undefined> {
  try {
    await cleanup();
    return undefined;
  } catch (cause: unknown) {
    return { cause };
  }
}

function isCapturedFailure(
  failure: CapturedFailure | undefined,
): failure is CapturedFailure {
  return failure !== undefined;
}

/**
 * A failed write owns every cleanup attempt until settlement. Cleanup must not
 * replace the write failure, but each additional failure remains necessary to
 * diagnose whether the reader or writable resource was released.
 */
function throwWithCleanupFailures({ cleanupFailures, message, primaryFailure }: {
  cleanupFailures: readonly CapturedFailure[];
  message: string;
  primaryFailure: unknown;
}): never {
  if (cleanupFailures.length === 0) throw primaryFailure;
  throw new AggregateError(
    [primaryFailure, ...cleanupFailures.map(({ cause }) => cause)],
    message,
  );
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
