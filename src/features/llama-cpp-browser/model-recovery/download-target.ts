import { modelLaunchTargetSchema, type ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { isMissing, readJournal, repositoryFolder } from '@/features/llama-cpp-browser/hugging-face/storage';
import { readModelLaunchReference } from '@/features/llama-cpp-browser/model-launch/reference';
import { targetForChoice } from '@/features/llama-cpp-browser/model-launch/target';

/** Called only after the explicit Review download action, never by rendering a
 * saved Chat. Resolve the exact stored file identity, not a quantization alias. */
export async function resolveRecoveryDownload({ modelId, signal }: { modelId: string, signal: AbortSignal }): Promise<ModelLaunchTarget> {
  signal.throwIfAborted();
  const reference = readModelLaunchReference({ modelId });
  if (reference === undefined) throw new Error('No exact download source for this model');
  const { repository, mainFilePath } = reference;
  try {
    const folder = await repositoryFolder({ repository, create: false });
    const journal = await readJournal({ folder });
    signal.throwIfAborted();
    if (journal.selection.repository !== repository || !journal.selection.files.some(file => file.path === mainFilePath)) {
      throw new Error('Another download owns this repository');
    }
    // Keep the already-started download's pinned revision and companion files.
    return modelLaunchTargetSchema.parse({ modelId, mainFilePath, selection: journal.selection });
  } catch (error) {
    if (!isMissing({ error })) throw error;
  }
  signal.throwIfAborted();
  const catalog = await getMetadataSession().inspect({ input: repository, signal, freshness: 'reuse' });
  signal.throwIfAborted();
  if (catalog.repository !== repository) throw new Error('Download repository changed');
  const target = targetForChoice({ catalog, path: mainFilePath });
  if (target.modelId !== modelId) throw new Error('Download model identity changed');
  return target;
}

export const TEST_ONLY = {
};
