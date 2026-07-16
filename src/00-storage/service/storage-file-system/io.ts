import type {
  StorageFileHandle,
  StorageWritableFile,
} from './types';

const DEFAULT_STREAM_CHUNK_SIZE = 1024 * 1024;

export async function readStorageFileText({ fileHandle }: {
  fileHandle: StorageFileHandle;
}): Promise<string> {
  const readable = await fileHandle.openReadable({ mimeType: 'text/plain' });
  try {
    return await new Response(readable.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    })).text();
  } finally {
    await readable.close();
  }
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
  } catch (error) {
    await abortAfterWriteFailure({ writable, error });
    throw error;
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
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the original read or write failure.
    }
    await abortAfterWriteFailure({ writable, error });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function abortAfterWriteFailure({ writable, error }: {
  writable: StorageWritableFile;
  error: unknown;
}): Promise<void> {
  try {
    await writable.abort({ reason: error });
  } catch {
    // Preserve the original write failure.
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
