import { validateLinkedModelRoot } from '@/logic/model-directory-input';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

export async function validateLinkedModelDirectory({ directory, signal }: { directory: FileSystemDirectoryHandle, signal: AbortSignal | undefined }): Promise<void> {
  try {
    await validateLinkedModelRoot({ directory, signal });
  } catch {
    signal?.throwIfAborted();
    throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  }
}

export const TEST_ONLY = {
};
