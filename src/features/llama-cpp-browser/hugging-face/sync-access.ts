import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
export type DownloadAccess = {
  getSize(): number,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native OPFS API.
  truncate(size: number): void,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native OPFS API.
  write(bytes: Uint8Array, options: { at: number }): number,
  flush(): void,
  close(): void,
};
export async function openSyncAccess({ handle }: { handle: FileSystemFileHandle }): Promise<DownloadAccess> {
  const file = handle as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<DownloadAccess> };
  if (!file.createSyncAccessHandle) throw new LlamaCppBrowserError({ code: 'unavailable' });
  return file.createSyncAccessHandle();
}
export const TEST_ONLY = {
};
