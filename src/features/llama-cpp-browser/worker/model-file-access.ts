import type { ModelFile } from '@/features/llama-cpp-browser/runtime/model-directory';
import type { ModelFileSource } from '@/features/llama-cpp-browser/runtime/model-file-source';
import { maximumModelReadBytes, maximumModelReadTailBytes } from '@/features/llama-cpp-browser/runtime/model-file-source';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

type ModelFileAccess = {
  getSize(): number,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native filesystem reader ABI.
  read(destination: Uint8Array, options: { at: number }): number,
  readWithTail?: ModelFileSource['readWithTail'],
  close(): void,
};
declare const FileReaderSync: { new(): {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Standard Worker FileReaderSync API.
  readAsArrayBuffer(blob: Blob): ArrayBuffer,
} };

/** Native host and temporary files have no OPFS sync handle. Read bounded slices directly
 * from their File snapshot in this Worker; never stage model bytes in OPFS. */
export async function openModelFileAccess({ entry }: { entry: ModelFile }): Promise<ModelFileAccess> {
  switch (entry.storageKind) {
  case 'host': case 'temp': {
    if (typeof FileReaderSync !== 'function') {
      throw new LlamaCppBrowserError({ code: 'unavailable' });
    }
    let file: File;
    const kind = entry.storageKind;
    switch (kind) {
    case 'temp': file = entry.file;
      break;
    case 'host': file = await entry.handle.getFile();
      break;
    default: {
      const exhaustive: never = kind;
      throw new Error(String(exhaustive));
    }
    }
    if (file.size !== entry.file.size || file.lastModified !== entry.file.lastModified) {
      throw new LlamaCppBrowserError({ code: 'storage-error' });
    }
    const reader = new FileReaderSync();
    let closed = false;
    return {
      getSize: () => file.size,
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Native filesystem reader ABI.
      read(destination, { at }) {
        if (closed || !Number.isSafeInteger(at) || at < 0) {
          throw new LlamaCppBrowserError({ code: 'storage-error' });
        }
        const size = Math.min(destination.length, Math.max(0, file.size - at));
        // The mounted reader's cache bounds each call; also bound direct callers.
        const length = Math.min(size, maximumModelReadBytes);
        const bytes = new Uint8Array(reader.readAsArrayBuffer(file.slice(at, at + length)));
        if (bytes.length !== length) {
          throw new LlamaCppBrowserError({ code: 'storage-error' });
        }
        destination.set(bytes);
        return bytes.length;
      },
      readWithTail({ destination, offset, tail }) {
        if (closed || !Number.isSafeInteger(offset) || offset < 0) {
          throw new LlamaCppBrowserError({ code: 'storage-error' });
        }
        const bodyLength = Math.min(destination.length, Math.max(0, file.size - offset), maximumModelReadBytes);
        const tailLength = bodyLength === destination.length && bodyLength > 0
          ? Math.min(tail.length, maximumModelReadTailBytes, file.size - offset - bodyLength) : 0;
        const length = bodyLength + tailLength;
        const bytes = new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + length)));
        if (bytes.length !== length) {
          throw new LlamaCppBrowserError({ code: 'storage-error' });
        }
        // Keep only the small tail in the caller-owned cache. Retaining a view
        // of this ArrayBuffer would keep the entire large read alive.
        destination.set(bytes.subarray(0, bodyLength));
        tail.set(bytes.subarray(bodyLength));
        return bytes.length;
      },
      close() {
        closed = true;
      },
    };
  }
  case 'opfs': {
    const handle = entry.handle as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<ModelFileAccess> };
    if (!handle.createSyncAccessHandle) {
      throw new LlamaCppBrowserError({ code: 'unavailable' });
    }
    return handle.createSyncAccessHandle();
  }
  default: {
    const exhaustive: never = entry;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
