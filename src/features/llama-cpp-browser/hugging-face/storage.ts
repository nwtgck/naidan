import { rankedProjectors } from './presentation';
import { modelGroups, variantLabel, isProjector } from './model-variants';
import { deletionPlanSchema, executeDeletionPlan, type DeletionPlan, type DeletionResult } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { describeDirectory, opfsRoot, readModelFiles, resolveModelFiles, validGguf, type ModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
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
export async function repositoryDirectories({ repository }: { repository: string }): Promise<ModelDirectory[]> {
  const folder = await repositoryFolder({ repository, create: false });
  let pending: DownloadJournal | undefined;
  try {
    pending = await readJournal({ folder });
  } catch (error) {
    if (!isMissing({ error })) throw error;
  }
  const hidden = new Set(pending?.selection.files.filter((_file, index) => !pending?.reused?.[index]).map(file => file.path));
  const actual = (await readModelFiles({ folder, prefix: '' })).filter(file => !hidden.has(file.path));
  const { models, projectors } = modelGroups({ files: actual }); const result: ModelDirectory[] = [];
  for (const group of models) {
    const files = [...group, ...rankedProjectors({ files: projectors }).slice(0, 1)];
    try {
      const resolved = resolveModelFiles({ files });
      if (!await allValid({ files })) continue;
      const id = `${modelName({ repository })}:${encodeURIComponent(resolved.modelPath)}`;
      const split = /-\d{5}-of-(\d{5})\.gguf$/i.exec(resolved.modelPath);
      const label = variantLabel({ repository, path: resolved.modelPath });
      // Split identities are visible even before a same-stem unsplit file is added.
      const name = `${modelName({ repository })}:${label}${split ? ` (split-${split[1]})` : ''}`;
      result.push({ id, name, files, ...resolved });
    } catch (error) {
      if (!(error instanceof LlamaCppBrowserError)) throw error;
    }
  }
  return result;
}
async function allValid({ files }: { files: ModelDirectory['files'] }): Promise<boolean> {
  for (const entry of files) if (!await validGguf({ file: entry.file })) return false;
  return true;
}
export function parseModelReference({ name }: { name: string }): { repository: string, variant: string | undefined } {
  if (!name.startsWith('hf.co/')) throw new LlamaCppBrowserError({ code: 'missing-model' });
  const value = name.slice('hf.co/'.length); const colon = value.indexOf(':');
  return { repository: repositorySchema.parse(colon < 0 ? value : value.slice(0, colon)), variant: colon < 0 ? undefined : value.slice(colon + 1) };
}
export async function resolveRepositoryModel({ name }: { name: string }): Promise<ModelDirectory> {
  const { repository, variant } = parseModelReference({ name }); const models = await repositoryDirectories({ repository });
  const matching = variant === undefined ? models : models.filter(model => model.id === name || model.name === name);
  if (matching.length !== 1) throw new LlamaCppBrowserError({ code: matching.length ? 'unsupported-input' : 'missing-model' });
  return matching[0]!;
}
export async function listHuggingFaceModels(): Promise<LocalModel[]> {
  const result: LocalModel[] = [];
  await visitRepositories({ visit: async ({ repository }) => {
    result.push(...(await repositoryDirectories({ repository })).map(directory => describeDirectory({ directory })));
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
  const current = await folder.getDirectoryHandle('main');
  let journal: DownloadJournal | undefined;
  try {
    journal = await readJournal({ folder: current });
  } catch (error) {
    if (!isMissing({ error })) throw error;
  }
  const selectedPaths = journal ? [pendingName, ...journal.selection.files.filter((_file, index) => !journal!.reused?.[index]).map(file => file.path)] : (await resolveRepositoryModel({ name: plan.id })).files.filter(file => plan.sharedProjector !== 'keep' || !isProjector({ path: file.path })).map(file => file.path);
  const result = await executeDeletionPlan({ folder: current, plan, selectedPaths });
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
