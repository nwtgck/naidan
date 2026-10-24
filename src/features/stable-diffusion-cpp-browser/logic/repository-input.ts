import type { RepositoryInput } from './repository-store';
import { modelDirectoryFromFiles, droppedModelFiles, directoryForGgufFile } from '@/logic/model-directory-input';
import { validModelPath } from './model-path';

export function imageDirectoryFromFiles({ files }: { files: File[] }): RepositoryInput {
  return modelDirectoryFromFiles({ files });
}

/** A loose weight has the same directory shape for OPFS and temporary use. */
export function imageDirectoryForFile({ file }: { file: File }): RepositoryInput {
  const match = /^(.+)\.(gguf|safetensors|sft)$/i.exec(file.name);
  if (!match || !validModelPath({ path: file.name }) || file.name.includes('/')) {
    throw new Error('Choose GGUF or safetensors model files');
  }
  if (match[2]!.toLowerCase() === 'gguf') {
    return directoryForGgufFile({ file });
  }
  return { rootName: `${match[1]}-Safetensors`, files: [{ relativePath: file.name, file }] };
}

export async function imageDirectoriesFromDrop({ transfer, signal }: { transfer: DataTransfer, signal: AbortSignal | undefined }): Promise<RepositoryInput[]> {
  const { directories, files } = await droppedModelFiles({ transfer, signal });
  return [...directories, ...files.map(file => imageDirectoryForFile({ file }))];
}

export const TEST_ONLY = {
};
