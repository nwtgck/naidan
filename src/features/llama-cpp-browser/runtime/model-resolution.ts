import { storageService } from '@/00-storage/service';
import { resolveRepositoryModel, parseModelReference } from '@/features/llama-cpp-browser/hugging-face/storage';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { resolveHostModel } from './host-model-store';
import { allowedModelDirectory, existingUserModelDirectory, resolveDirectory, type ResolvedModel } from './model-directory';
import { temporaryModels } from './temporary-model-store';

/** Resolve before queueing. Workers receive these captured files and handles,
 * so later alias edits cannot select a different model for an accepted request.
 */
export async function resolveModel({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<ResolvedModel> {
  signal?.throwIfAborted();
  if (modelId.startsWith('temp/')) {
    const resolved = await temporaryModels.resolveModel({ modelId, signal });
    if (!resolved) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
    return resolved;
  }
  if (modelId.startsWith('host/')) {
    const directories = await storageService.loadHostModelDirectories();
    signal?.throwIfAborted();
    return resolveHostModel({ modelId, directories, signal });
  }
  if (modelId.startsWith('hf.co/')) {
    const { repository } = parseModelReference({ modelId });
    const directory = await resolveRepositoryModel({ modelId, signal });
    signal?.throwIfAborted();
    return { modelId, location: { kind: 'hugging-face', repository }, directory };
  }
  const [source, rootName, ...extra] = modelId.split('/');
  if (source !== 'user' || !rootName || extra.length || !allowedModelDirectory({ name: rootName })) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  try {
    const parent = await existingUserModelDirectory();
    if (!parent) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
    const directory = await resolveDirectory({ folder: await parent.getDirectoryHandle(rootName), signal });
    signal?.throwIfAborted();
    return { modelId, location: { kind: 'opfs-user', rootName }, directory };
  } catch (error) {
    if (error instanceof DOMException && ['NotFoundError', 'TypeMismatchError'].includes(error.name)) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
    throw error;
  }
}

export const TEST_ONLY = {
};
