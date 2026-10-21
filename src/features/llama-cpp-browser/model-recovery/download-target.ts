import { type ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { formatHuggingFaceModelId } from '@/01-models/llama-cpp-browser-model-id';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { isMissing, readJournal, repositoryFolder } from '@/features/llama-cpp-browser/hugging-face/storage';
import { readModelLaunchReference } from '@/features/llama-cpp-browser/model-launch/reference';
import { targetForChoice, targetForSelection, modelLaunchChoices } from '@/features/llama-cpp-browser/model-launch/target';

/** Called only after the explicit Review download action, never by rendering a
 * saved Chat. Resolve the public selection against the current catalog or captured plan. */
export async function resolveRecoveryDownload({ modelId, signal }: { modelId: string, signal: AbortSignal }): Promise<ModelLaunchTarget> {
  signal.throwIfAborted();
  const reference = readModelLaunchReference({ modelId });
  if (reference === undefined) {
    throw new Error('No download source for this model');
  }
  const { repository } = reference;
  try {
    const folder = await repositoryFolder({ repository, create: false });
    const journal = await readJournal({ folder });
    signal.throwIfAborted();
    const target = targetForSelection({ selection: journal.selection });
    if (journal.selection.repository !== repository || target.modelId !== modelId) {
      throw new Error('Another download owns this repository');
    }
    // Keep the already-started download's pinned revision and companion files.
    return target;
  } catch (error) {
    if (!isMissing({ error })) {
      throw error;
    }
  }
  signal.throwIfAborted();
  const catalog = await getMetadataSession().inspect({ input: repository, signal, freshness: 'reuse' });
  signal.throwIfAborted();
  if (catalog.repository !== repository) {
    throw new Error('Download repository changed');
  }
  const matching = modelLaunchChoices({ catalog }).filter(choice => formatHuggingFaceModelId({ repository, mainFilePath: choice.primaryRelativePath }) === modelId);
  if (matching.length !== 1) {
    throw new Error('Download model selection unavailable');
  }
  const target = targetForChoice({ catalog, path: matching[0]!.primaryRelativePath });
  if (target.modelId !== modelId) {
    throw new Error('Download model identity changed');
  }
  return target;
}

export const TEST_ONLY = {
};
