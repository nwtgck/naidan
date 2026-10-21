import { formatHuggingFaceModelId } from '@/01-models/llama-cpp-browser-model-id';
import { modelLaunchTargetSchema, type ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { isMissing, readJournal, repositoryFolder, repositoryDirectories } from '@/features/llama-cpp-browser/hugging-face/storage';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { rememberLaunchCatalog, targetForChoice, targetForSelection, modelLaunchChoices } from './target';
import { readModelLaunchReference } from './reference';
import type { ModelLaunchView } from './history';

/** Rebuild volatile UI state. Never rewrite a stored Chat or start a transfer. */
export async function restoreModelLaunchTarget({ view, signal }: { view: ModelLaunchView, signal: AbortSignal }): Promise<ModelLaunchTarget> {
  signal.throwIfAborted();
  const reference = readModelLaunchReference({ modelId: view.modelId });
  if (reference === undefined) {
    throw new Error('Invalid model launch identity');
  }
  const { repository, modelId } = reference;
  try {
    const folder = await repositoryFolder({ repository, create: false });
    const journal = await readJournal({ folder });
    signal.throwIfAborted();
    if (journal.selection.repository === repository) {
      const target = targetForSelection({ selection: journal.selection });
      if (target.modelId === modelId) {
        // An interrupted transfer owns its pinned revision, not today's catalog.
        return target;
      }
    }
  } catch (error) {
    if (!isMissing({ error })) {
      throw error;
    }
  }
  signal.throwIfAborted();
  try {
    const matching = (await repositoryDirectories({ repository })).filter(candidate => formatHuggingFaceModelId({ repository, mainFilePath: candidate.primaryFile.relativePath }) === modelId);
    if (matching.length > 1) {
      throw new Error('Ambiguous model launch selection');
    }
    const directory = matching[0];
    signal.throwIfAborted();
    if (directory !== undefined) {
      return modelLaunchTargetSchema.parse({
        modelId,
        mainFilePath: directory.primaryFile.relativePath,
        selection: { repository, revision: view.revision, files: directory.files.map(file => ({ path: file.relativePath, size: file.file.size })) },
      });
    }
  } catch (error) {
    if (!isMissing({ error })) {
      throw error;
    }
  }
  // Only the current history entry's explicit link authorizes this metadata
  // request. A plain saved Chat is not permission for background discovery.
  const catalog = await getMetadataSession().inspect({ input: view.input, signal, freshness: 'reuse' });
  signal.throwIfAborted();
  if (catalog.repository !== repository) {
    throw new Error('Model launch repository changed');
  }
  const matching = modelLaunchChoices({ catalog }).filter(choice => formatHuggingFaceModelId({ repository, mainFilePath: choice.primaryRelativePath }) === modelId);
  if (matching.length !== 1) {
    throw new Error('Model launch selection unavailable');
  }
  const target = targetForChoice({ catalog, path: matching[0]!.primaryRelativePath });
  rememberLaunchCatalog({ catalog });
  return target;
}

export const TEST_ONLY = {
};
