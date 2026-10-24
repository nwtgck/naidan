import { LlamaCppBrowserError, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { modelDirectoryFromFiles, droppedModelFiles } from '@/logic/model-directory-input';

export function directoryFromFiles({ files }: { files: File[] }): ModelDirectoryInput {
  try {
    return modelDirectoryFromFiles({ files });
  } catch {
    throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  }
}

export async function droppedModels({ transfer, signal }: { transfer: DataTransfer, signal?: AbortSignal }): Promise<{ directories: ModelDirectoryInput[], files: File[] }> {
  try {
    const result = await droppedModelFiles({ transfer, signal });
    if (result.files.some(file => !/\.gguf$/i.test(file.name))) {
      throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    }
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LlamaCppBrowserError) {
      throw error;
    }
    throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  }
}

export const TEST_ONLY = {
};
