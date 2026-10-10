import { type HostModelDirectoryId, idToRaw } from '@/01-models/ids';
import { listHuggingFaceModels, repositoryDirectories } from '@/features/llama-cpp-browser/hugging-face/storage';
import { LlamaCppBrowserError, type LocalModel } from '@/features/llama-cpp-browser/types';
import { hostModelRoot, parseHostModelReference } from './model-destination';
import { hostModelPublicName } from './host-model-aliases';
import type { ModelDirectory } from './model-directory';

export type HostModelInventoryIssue = { directoryId: string, directoryName: string, message: string };
let issues: HostModelInventoryIssue[] = [];

export function recordOpfsInventoryIssue({ error }: { error: unknown }): void {
  issues = [{ directoryId: 'opfs', directoryName: 'OPFS', message: error instanceof Error ? error.message : String(error) }, ...issues];
}

export function getHostModelInventoryIssues(): readonly HostModelInventoryIssue[] {
  return issues;
}

/** Each root is independent. Losing permission never hides another root's models. */
export async function listHostStoredModels({ directories, signal }: {
  directories: readonly { id: HostModelDirectoryId, name: string }[], signal: AbortSignal | undefined,
}): Promise<LocalModel[]> {
  const result: LocalModel[] = []; const unavailable: HostModelInventoryIssue[] = [];
  for (const directory of directories) {
    signal?.throwIfAborted(); const directoryId = idToRaw({ id: directory.id });
    try {
      const models = await listHuggingFaceModels({
        destination: { kind: 'host', directoryId },
        onIssue: ({ repository, error }) => {
          unavailable.push({ directoryId, directoryName: `${directory.name}/${repository}`, message: error instanceof Error ? error.message : String(error) });
        },
      });
      for (const model of models) {
        const { repository, modelPath } = parseHostModelReference({ name: model.id });
        if (modelPath === undefined) continue;
        result.push({ ...model, name: hostModelPublicName({ name: model.id, directories }), source: { kind: 'host', directoryId, directoryName: directory.name, repository, path: modelPath } });
      }
    } catch (error) {
      signal?.throwIfAborted();
      unavailable.push({ directoryId, directoryName: directory.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  signal?.throwIfAborted(); issues = unavailable;
  return result;
}

/** Worker resolution reads only the captured IDB handle, never UI settings. */
export async function resolveHostModel({ name }: { name: string }): Promise<ModelDirectory> {
  const { destination, repository, modelPath } = parseHostModelReference({ name });
  if (modelPath === undefined) throw new LlamaCppBrowserError({ code: 'missing-model' });
  await hostModelRoot({ destination, mode: 'read' });
  const models = await repositoryDirectories({ repository, destination });
  const selected = models.find(model => model.id === name);
  if (!selected) throw new LlamaCppBrowserError({ code: 'missing-model' });
  return selected;
}

export const TEST_ONLY = {
};
