import type { ModelFile } from '@/features/llama-cpp-browser/runtime/model-directory';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

type ModelFileAccess = {
  getSize(): number,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native filesystem reader ABI.
  read(destination: Uint8Array, options: { at: number }): number,
  close(): void,
};
declare const FileReaderSync: { new(): {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Standard Worker FileReaderSync API.
  readAsArrayBuffer(blob: Blob): ArrayBuffer,
} };

/** Native host files have no OPFS sync handle. Read bounded slices directly
 * from their File snapshot in this Worker; never stage model bytes in OPFS. */
export async function openModelFileAccess({ entry }: { entry: ModelFile }): Promise<ModelFileAccess> {
  switch (entry.storageKind) {
  case 'host': {
    if (typeof FileReaderSync !== 'function') throw new LlamaCppBrowserError({ code: 'unavailable' });
    const file = await entry.handle.getFile();
    if (file.size !== entry.file.size || file.lastModified !== entry.file.lastModified) throw new LlamaCppBrowserError({ code: 'storage-error' });
    const reader = new FileReaderSync(); let closed = false;
    return {
      getSize: () => file.size,
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Native filesystem reader ABI.
      read(destination, { at }) {
        if (closed || !Number.isSafeInteger(at) || at < 0) throw new LlamaCppBrowserError({ code: 'storage-error' });
        const size = Math.min(destination.length, Math.max(0, file.size - at));
        // The mounted reader's cache bounds each call; also bound direct callers.
        const length = Math.min(size, 8 * 1024 * 1024);
        const bytes = new Uint8Array(reader.readAsArrayBuffer(file.slice(at, at + length)));
        if (bytes.length !== length) throw new LlamaCppBrowserError({ code: 'storage-error' });
        destination.set(bytes); return bytes.length;
      },
      close() {
        closed = true;
      },
    };
  }
  case undefined: {
    const handle = entry.handle as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<ModelFileAccess> };
    if (!handle.createSyncAccessHandle) throw new LlamaCppBrowserError({ code: 'unavailable' });
    return handle.createSyncAccessHandle();
  }
  default: { const exhaustive: never = entry.storageKind; throw new Error(String(exhaustive)); }
  }
}

export const TEST_ONLY = {
};
