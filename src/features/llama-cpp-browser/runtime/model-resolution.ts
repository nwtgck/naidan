import { storageService } from '@/00-storage/service';
import { resolveRepositoryModel, parseModelReference } from '@/features/llama-cpp-browser/hugging-face/storage';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { resolveHostModel } from './host-model-store';
import { existingUserModelDirectory, resolveDirectory, resolveLocalRepositoryDirectories, type ResolvedModel } from './model-directory';
import { temporaryModels } from './temporary-model-store';
import { localRepositories } from './local-repository-store';
import { hasLocalRepositoryReferencePrefix, parseLocalRepositoryReference } from '@/01-models/llama-cpp-browser-model-id';
import { hasTemporaryModelPathPrefix } from '@/01-models/temporary-model-files';

/** Resolve before queueing. Workers receive these captured files and handles,
 * so later alias edits cannot select a different model for an accepted request.
 */
export async function resolveModel({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<ResolvedModel> {
  signal?.throwIfAborted();
  const local = await localRepositories.resolve({ modelId, signal });
  if (local) {
    return local;
  }
  if (hasLocalRepositoryReferencePrefix({ modelId, storage: 'pending' })) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  if (hasTemporaryModelPathPrefix({ path: modelId })) {
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
  let reference: ReturnType<typeof parseLocalRepositoryReference>;
  try {
    reference = parseLocalRepositoryReference({ modelId });
  } catch {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  const { rootName, selector } = reference;
  try {
    const parent = await existingUserModelDirectory();
    if (!parent) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
    const folder = await parent.getDirectoryHandle(rootName);
    const directory = selector === undefined ? await resolveDirectory({ folder, signal })
      : (await resolveLocalRepositoryDirectories({ folder, rootName, signal })).find(configuration => configuration.selector === selector)?.directory;
    if (!directory) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
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
