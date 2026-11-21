import { parseRepositoryModelId } from '@/01-models/llama-cpp-browser-model-id';
import { type HostModelDirectoryId, idToRaw } from '@/01-models/ids';
import { listHuggingFaceModels, repositoryDirectories } from '@/features/llama-cpp-browser/hugging-face/storage';
import { selectRepositoryModel } from '@/features/llama-cpp-browser/hugging-face/model-selector';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { resolveHostModelLocation } from './host-model-aliases';
import type { ResolvedModel } from './model-directory';

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
  const result: LocalModel[] = [];
  const unavailable: HostModelInventoryIssue[] = [];
  for (const directory of directories) {
    signal?.throwIfAborted();
    const directoryId = idToRaw({ id: directory.id });
    try {
      const models = await listHuggingFaceModels({
        destination: { kind: 'host', directoryId },
        directories,
        signal,
        onIssue: ({ repository, error }) => {
          unavailable.push({ directoryId, directoryName: `${directory.name}/${repository}`, message: error instanceof Error ? error.message : String(error) });
        },
      });
      result.push(...models);
    } catch (error) {
      signal?.throwIfAborted();
      unavailable.push({ directoryId, directoryName: directory.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  signal?.throwIfAborted();
  issues = unavailable;
  return result;
}

/** Capture the current readable candidate and its source files together. */
export async function resolveHostModel({ modelId, directories, signal }: { modelId: string, directories: readonly { id: HostModelDirectoryId, name: string }[], signal: AbortSignal | undefined }): Promise<ResolvedModel> {
  const { directoryId, repository } = resolveHostModelLocation({ modelId, directories });
  const destination = { kind: 'host' as const, directoryId };
  const { configuration, variant } = parseRepositoryModelId({ modelId });
  const models = await repositoryDirectories({ repository, destination, signal, configuration });
  const directory = selectRepositoryModel({ models, repository, variant });
  signal?.throwIfAborted();
  return { modelId, location: { kind: 'host', directoryId, repository }, directory };
}

export const TEST_ONLY = {
};
