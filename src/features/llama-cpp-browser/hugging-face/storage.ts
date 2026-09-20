import { deletionPlanSchema, executeDeletionPlan, type DeletionPlan, type DeletionResult } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { describeDirectory, opfsRoot, resolveDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import { LlamaCppBrowserError, type LocalModel } from '@/features/llama-cpp-browser/types';
import { journalSchema, modelName, pendingName, repositorySchema, type DownloadJournal } from './types';

export function isMissing({ error }: { error: unknown }): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}
export async function repositoryFolder({ repository, create }: { repository: string, create: boolean }): Promise<FileSystemDirectoryHandle> {
  const [owner, repo] = repositorySchema.parse(repository).split('/');
  let folder = await opfsRoot();
  for (const name of ['llama-cpp-browser-models', 'huggingface.co', owner!, repo!, 'resolve', 'main']) folder = await folder.getDirectoryHandle(name, { create });
  return folder;
}
export async function selectedFile({ folder, path, create }: { folder: FileSystemDirectoryHandle, path: string, create: boolean }): Promise<FileSystemFileHandle> {
  const parts = path.split('/'); const name = parts.pop()!;
  for (const part of parts) folder = await folder.getDirectoryHandle(part, { create });
  return folder.getFileHandle(name, { create });
}
export async function readJournal({ folder }: { folder: FileSystemDirectoryHandle }): Promise<DownloadJournal> {
  const file = await (await folder.getFileHandle(pendingName)).getFile();
  if (file.size > 4 * 1024 * 1024) throw new Error('Download journal exceeds the size limit');
  return journalSchema.parse(JSON.parse(await file.text()));
}
export async function writeJournal({ folder, journal }: { folder: FileSystemDirectoryHandle, journal: DownloadJournal }): Promise<void> {
  const writer = await (await folder.getFileHandle(pendingName, { create: true })).createWritable();
  try {
    await writer.write(JSON.stringify(journalSchema.parse(journal))); await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {}); throw error;
  }
}
export async function visitRepositories({ visit }: { visit: ({ repository, folder }: { repository: string, folder: FileSystemDirectoryHandle }) => Promise<void> }): Promise<void> {
  let host: FileSystemDirectoryHandle;
  try {
    host = await (await (await opfsRoot()).getDirectoryHandle('llama-cpp-browser-models')).getDirectoryHandle('huggingface.co');
  } catch (error) {
    if (isMissing({ error })) return; throw error;
  }
  for await (const [owner, ownerFolder] of host.entries()) {
    switch (ownerFolder.kind) {
    case 'file': continue; case 'directory': break; default: { const exhaustive: never = ownerFolder; throw new Error(String(exhaustive)); }
    }
    for await (const [repo, repoFolder] of ownerFolder.entries()) {
      switch (repoFolder.kind) {
      case 'file': continue; case 'directory': break; default: { const exhaustive: never = repoFolder; throw new Error(String(exhaustive)); }
      }
      const repository = `${owner}/${repo}`; if (!repositorySchema.safeParse(repository).success) continue;
      try {
        await visit({ repository, folder: await (await repoFolder.getDirectoryHandle('resolve')).getDirectoryHandle('main') });
      } catch (error) {
        if (!isMissing({ error })) throw error;
      }
    }
  }
}
export async function listHuggingFaceModels(): Promise<LocalModel[]> {
  const result: LocalModel[] = [];
  await visitRepositories({ visit: async ({ repository, folder }) => {
    const name = modelName({ repository });
    try {
      result.push(describeDirectory({ directory: await resolveDirectory({ folder, id: name, name }) }));
    } catch (error) {
      if (!(error instanceof LlamaCppBrowserError)) throw error;
    }
  } });
  return result;
}
export async function listPendingDownloads(): Promise<DownloadJournal[]> {
  const result: DownloadJournal[] = [];
  await visitRepositories({ visit: async ({ repository, folder }) => {
    const journal = await readJournal({ folder });
    if (journal.selection.repository !== repository) throw new Error('Download journal repository mismatch');
    result.push(journal);
  } });
  return result;
}
export async function withRepositoryLock<T>({ repository, operation }: { repository: string, operation: () => Promise<T> }): Promise<T> {
  repositorySchema.parse(repository);
  if (!navigator.locks) throw new LlamaCppBrowserError({ code: 'unavailable' });
  return navigator.locks.request(`naidan-llama-cpp-browser-hf:${repository}`, { ifAvailable: true }, lock => {
    if (!lock) throw new LlamaCppBrowserError({ code: 'busy' }); return operation();
  });
}
export async function deleteRepository({ repository, plan }: { repository: string, plan: DeletionPlan }): Promise<DeletionResult> {
  plan = deletionPlanSchema.parse(plan);
  if (plan.id !== modelName({ repository })) throw new Error('Deletion plan does not match the repository');
  const [owner, repo] = repositorySchema.parse(repository).split('/');
  let folder = await opfsRoot();
  for (const name of ['llama-cpp-browser-models', 'huggingface.co', owner!, repo!, 'resolve']) folder = await folder.getDirectoryHandle(name);
  const result = await executeDeletionPlan({ folder: await folder.getDirectoryHandle('main'), plan, selectedPaths: undefined });
  switch (result) {
  case 'changed': return result;
  case 'deleted': break;
  default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
  }
  try {
    await folder.getDirectoryHandle('main'); await folder.removeEntry('main');
  } catch (error) {
    if (!(error instanceof DOMException && ['NotFoundError', 'InvalidModificationError', 'TypeMismatchError'].includes(error.name))) throw error;
  }
  return result;
}
export const TEST_ONLY = {
};
