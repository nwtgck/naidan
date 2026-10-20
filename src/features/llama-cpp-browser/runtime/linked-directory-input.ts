import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

/** Linked roots always mean root/owner/repository/... . Never auto-wrap or
 * reinterpret a loose GGUF folder in link mode. Only inspect the two structural
 * levels: repository contents remain untouched, and an empty destination is
 * valid because it can receive future downloads. This is a linking policy, not
 * the saved/temporary model-directory input policy. */
export async function validateLinkedModelDirectory({ directory, signal }: { directory: FileSystemDirectoryHandle, signal: AbortSignal | undefined }): Promise<void> {
  signal?.throwIfAborted();
  for await (const [name, entry] of directory.entries()) {
    signal?.throwIfAborted();
    switch (entry.kind) {
    case 'file':
      if (/\.gguf$/i.test(name)) {
        throw new LlamaCppBrowserError({ code: 'unsupported-input' });
      }
      break;
    case 'directory':
      for await (const [childName, child] of entry.entries()) {
        signal?.throwIfAborted();
        if (child.kind === 'file' && /\.gguf$/i.test(childName)) {
          throw new LlamaCppBrowserError({ code: 'unsupported-input' });
        }
      }
      break;
    default: {
      const exhaustive: never = entry;
      throw new Error(String(exhaustive));
    }
    }
  }
}

export const TEST_ONLY = {
};
