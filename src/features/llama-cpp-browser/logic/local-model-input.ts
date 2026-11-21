import { directoryFromFiles, droppedModels } from '@/features/llama-cpp-browser/runtime/directory-input';
import { directoryForModelFile } from '@/features/llama-cpp-browser/runtime/model-directory-input';
import { LlamaCppBrowserError, type LocalModel, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { modelGroups } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { resolveModelFiles } from '@/features/llama-cpp-browser/runtime/model-file-selection';

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

/** Inspect only the GGUF headers here. A split weight group is useful only as a whole. */
export async function filterModelFilesForAddition({ directories, signal }: {
  directories: ModelDirectoryInput[], signal: AbortSignal,
}): Promise<{ directories: ModelDirectoryInput[], skipped: string[] }> {
  const { validGguf } = await import('@/features/llama-cpp-browser/runtime/model-directory');
  const accepted: ModelDirectoryInput[] = [];
  const skipped: string[] = [];
  for (const directory of directories) {
    const { models, projectors } = modelGroups({ files: directory.files.filter(file => /\.gguf$/i.test(file.relativePath)) });
    const files = directory.files.filter(file => !/\.gguf$/i.test(file.relativePath));
    const nonModelCount = files.length;
    for (const model of models) {
      try {
        resolveModelFiles({ files: model });
        for (const { file } of model) {
          signal.throwIfAborted();
          if (!await validGguf({ file })) {
            throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
          }
        }
        files.push(...model);
      } catch {
        signal.throwIfAborted();
        skipped.push(...model.map(file => directory.rootName + '/' + file.relativePath));
      }
    }
    if (files.length === nonModelCount) {
      skipped.push(...projectors.map(file => directory.rootName + '/' + file.relativePath));
      continue;
    }
    for (const projector of projectors) {
      signal.throwIfAborted();
      if (await validGguf({ file: projector.file }).catch(() => false)) {
        files.push(projector);
      } else {
        skipped.push(directory.rootName + '/' + projector.relativePath);
      }
    }
    accepted.push({ ...directory, files });
  }
  signal.throwIfAborted();
  return { directories: accepted, skipped };
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

export type LocalModelImportRequest = {
  directories: Promise<ModelDirectoryInput[]>,
  controller: AbortController,
  save: 'browser' | 'later',
  repositoryLayout: 'confirmed',
};

export const TEST_ONLY = {
};
