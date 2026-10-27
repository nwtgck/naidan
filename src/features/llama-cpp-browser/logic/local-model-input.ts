import { directoryFromFiles, droppedModels } from '@/features/llama-cpp-browser/runtime/directory-input';
import { directoryForModelFile } from '@/features/llama-cpp-browser/runtime/model-directory-input';
import { LlamaCppBrowserError, type LocalModel, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';

export function localModelDirectoriesFromFiles({ files, selection }: { files: File[], selection: 'files' | 'directory' }): ModelDirectoryInput[] {
  if (!files.length) {
    return [];
  }
  switch (selection) {
  case 'directory': return [directoryFromFiles({ files })];
  case 'files': {
    if (files.some(file => !/\.gguf$/i.test(file.name))) {
      throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    }
    const primary = files.find(file => !/mmproj/i.test(file.name));
    if (!primary) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    }
    const directory = directoryForModelFile({ file: primary });
    return [{ rootName: directory.rootName, files: files.map(file => ({ relativePath: file.name, file })) }];
  }
  default: {
    const exhaustive: never = selection;
    throw new Error(String(exhaustive));
  }
  }
}

/** Call during drop dispatch: the existing adapter captures entries immediately. */
export function captureDroppedLocalModels({ transfer, signal }: { transfer: DataTransfer, signal: AbortSignal | undefined }): Promise<ModelDirectoryInput[]> {
  const captured = droppedModels({ transfer, signal });
  return captured.then(({ directories, files }) => [...directories, ...localModelDirectoriesFromFiles({ files, selection: 'files' })]);
}

export async function importLocalModelDirectories({ directories, signal, save }: { directories: readonly ModelDirectoryInput[], signal: AbortSignal | undefined, save?: 'browser' | 'later' }): Promise<LocalModel[]> {
  const { llamaCppBrowserModelFiles } = await import('@/features/llama-cpp-browser/model-files');
  const models: LocalModel[] = [];
  for (const directory of directories) {
    signal?.throwIfAborted();
    const receipt = await llamaCppBrowserModelFiles.importLocalDirectory({ directory, save: save ?? 'later', signal });
    models.push(...receipt.models);
  }
  if (!models.length) {
    throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  }
  return models;
}

export const TEST_ONLY = {
};
