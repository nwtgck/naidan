import { hostDownloadMarker, hostDownloadMarkerPath } from './host-download-marker';
import { isHostDestination, hostModelRoot, hostModelReference, type ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination';
import { huggingFaceModelId } from '@/01-models/llama-cpp-browser-model-launch';
import { OPFS_MODELS_DIR } from '@/constants';
import { rankedProjectors } from './presentation';
import { modelGroups, variantLabel, isProjector } from './model-variants';
import { deletionPlanSchema, executeDeletionPlan, type DeletionPlan, type DeletionResult } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { describeDirectory, opfsRoot, readModelFiles, resolveModelFiles, validGguf, type ModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import { LlamaCppBrowserError, type LocalModel } from '@/features/llama-cpp-browser/types';
import { journalSchema, modelName, pendingName, repositorySchema, type DownloadJournal, type DownloadSelection } from './types';

export function isMissing({ error }: { error: unknown }): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}
export async function repositoryFolder({ repository, create, destination }: { repository: string, create: boolean, destination?: ModelDestination }): Promise<FileSystemDirectoryHandle> {
  const [owner, repo] = repositorySchema.parse(repository).split('/');
  let folder = isHostDestination(destination) ? await hostModelRoot({ destination, mode: create ? 'readwrite' : 'read' }) : await opfsRoot();
  const path = isHostDestination(destination) ? [owner!, repo!] : [OPFS_MODELS_DIR, 'huggingface.co', owner!, repo!, 'resolve', 'main'];
  for (const name of path) folder = await folder.getDirectoryHandle(name, { create });
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
export async function visitRepositories({ visit, destination, onIssue }: { destination?: ModelDestination, onIssue?: ({ repository, error }: { repository: string, error: unknown }) => void, visit: ({ repository, folder }: { repository: string, folder: FileSystemDirectoryHandle }) => Promise<void> }): Promise<void> {
  let host: FileSystemDirectoryHandle;
  try {
    host = isHostDestination(destination) ? await hostModelRoot({ destination, mode: 'read' }) : await (await (await opfsRoot()).getDirectoryHandle(OPFS_MODELS_DIR)).getDirectoryHandle('huggingface.co');
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
        await visit({ repository, folder: isHostDestination(destination) ? repoFolder : await (await repoFolder.getDirectoryHandle('resolve')).getDirectoryHandle('main') });
      } catch (error) {
        if (!isMissing({ error })) {
          if (onIssue) onIssue({ repository, error }); else throw error;
        }
      }
    }
  }
}
async function repositoryFiles({ repository, destination }: { repository: string, destination?: ModelDestination }): Promise<ModelDirectory['files']> {
  const folder = await repositoryFolder({ repository, create: false, destination });
  let pending: DownloadJournal | undefined;
  try {
    pending = await readJournal({ folder });
  } catch (error) {
    if (!isMissing({ error })) throw error;
  }
  const hidden = new Set(pending?.selection.files.filter((_file, index) => !pending?.reused?.[index]).map(file => file.path));
  return (await readModelFiles({ folder, prefix: '' })).filter(file => !hidden.has(file.path)).map(file => isHostDestination(destination) ? { ...file, storageKind: 'host' as const } : file);
}
export async function repositoryDirectories({ repository, destination }: { repository: string, destination?: ModelDestination }): Promise<ModelDirectory[]> {
  return describeRepositoryDirectories({ repository, actual: await repositoryFiles({ repository, destination }), destination });
}
async function describeRepositoryDirectories({ repository, actual, onlyModelPath, destination }: { repository: string, actual: ModelDirectory['files'], onlyModelPath?: string, destination?: ModelDestination }): Promise<ModelDirectory[]> {
  const { models, projectors } = modelGroups({ files: actual }); const result: ModelDirectory[] = [];
  for (const group of models) {
    const files = [...group, ...rankedProjectors({ files: projectors }).slice(0, 1)];
    try {
      const resolved = resolveModelFiles({ files });
      // A launch checks one exact model, not the headers of every quantization.
      // Keep grouping and projector selection identical to normal model listing.
      if (onlyModelPath !== undefined && resolved.modelPath !== onlyModelPath) continue;
      if (!await allValid({ files })) continue;
      const id = isHostDestination(destination) ? hostModelReference({ directoryId: destination.directoryId, repository, modelPath: resolved.modelPath }) : huggingFaceModelId({ repository, modelPath: resolved.modelPath });
      const split = /-\d{5}-of-(\d{5})\.gguf$/i.exec(resolved.modelPath);
      const label = variantLabel({ repository, path: resolved.modelPath });
      // Split identities are visible even before a same-stem unsplit file is added.
      const name = isHostDestination(destination) ? id : `${modelName({ repository })}:${label}${split ? ` (split-${split[1]})` : ''}`;
      result.push({ id, name, files, ...resolved });
    } catch (error) {
      if (!(error instanceof LlamaCppBrowserError)) throw error;
    }
  }
  return result;
}
export async function installedSelection({ selection, destination }: { selection: DownloadSelection, destination?: ModelDestination }): Promise<LocalModel | undefined> {
  let actual: ModelDirectory['files'];
  try {
    actual = await repositoryFiles({ repository: selection.repository, destination });
  } catch (error) {
    if (isMissing({ error })) return undefined; throw error;
  }
  const selectedFiles: ModelDirectory['files'] = [];
  for (const expected of selection.files) {
    const found = actual.find(file => file.path === expected.path && file.file.size === expected.size);
    if (!found) return undefined;
    selectedFiles.push(found);
  }
  // Availability uses local metadata and small headers, not a remote revision or checksum guarantee.
  if (!await allValid({ files: selectedFiles })) return undefined;
  const requested = resolveModelFiles({ files: selection.files });
  const directory = (await describeRepositoryDirectories({ repository: selection.repository, actual, onlyModelPath: requested.modelPath, destination })).find(model => model.modelPath === requested.modelPath);
  return directory ? describeDirectory({ directory }) : undefined;
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
export async function listHuggingFaceModels({ destination, onIssue }: { destination?: ModelDestination, onIssue?: ({ repository, error }: { repository: string, error: unknown }) => void } = {}): Promise<LocalModel[]> {
  const result: LocalModel[] = [];
  await visitRepositories({
    destination,
    onIssue,
    visit: async ({ repository }) => {
      result.push(...(await repositoryDirectories({ repository, destination })).map(directory => describeDirectory({ directory })));
    },
  });
  return result;
}
export async function listPendingDownloads({ destination }: { destination?: ModelDestination } = {}): Promise<DownloadJournal[]> {
  const result: DownloadJournal[] = [];
  await visitRepositories({
    destination,
    visit: async ({ repository, folder }) => {
      const journal = await readJournal({ folder });
      if (journal.selection.repository !== repository) throw new Error('Download journal repository mismatch');
      result.push(journal);
    },
  });
  return result;
}
export async function withRepositoryLock<T>({ repository, operation }: { repository: string, operation: () => Promise<T> }): Promise<T> {
  repositorySchema.parse(repository);
  if (!navigator.locks) throw new LlamaCppBrowserError({ code: 'unavailable' });
  return navigator.locks.request(`naidan-llama-cpp-browser-hf:${repository}`, { ifAvailable: true }, lock => {
    if (!lock) throw new LlamaCppBrowserError({ code: 'busy' }); return operation();
  });
}
export async function deleteRepository({ repository, plan, destination }: { repository: string, plan: DeletionPlan, destination?: ModelDestination }): Promise<DeletionResult> {
  plan = deletionPlanSchema.parse(plan);
  if (plan.id !== (isHostDestination(destination) ? hostModelReference({ directoryId: destination.directoryId, repository, modelPath: undefined }) : modelName({ repository }))) throw new Error('Deletion plan does not match the repository');
  const [owner, repo] = repositorySchema.parse(repository).split('/');
  let folder = isHostDestination(destination) ? await hostModelRoot({ destination, mode: 'readwrite' }) : await opfsRoot();
  for (const name of isHostDestination(destination) ? [owner!] : [OPFS_MODELS_DIR, 'huggingface.co', owner!, repo!, 'resolve']) folder = await folder.getDirectoryHandle(name);
  const leaf = isHostDestination(destination) ? repo! : 'main';
  const current = await folder.getDirectoryHandle(leaf);
  let journal: DownloadJournal | undefined;
  try {
    journal = await readJournal({ folder: current });
  } catch (error) {
    if (!isMissing({ error })) throw error;
  }
  if (journal && isHostDestination(destination)) for (let index = 0; index < journal.selection.files.length; index++) {
    if (!journal.reused?.[index]) await hostDownloadMarker({ folder: current, selection: journal.selection, index, action: 'check' });
  }
  const selectedPaths = journal ? [pendingName, ...journal.selection.files.filter((_file, index) => !journal!.reused?.[index]).flatMap(file => isHostDestination(destination) ? [file.path, hostDownloadMarkerPath({ path: file.path })] : [file.path])] : (await resolveRepositoryModel({ name: plan.id })).files.filter(file => plan.sharedProjector !== 'keep' || !isProjector({ path: file.path })).map(file => file.path);
  const result = await executeDeletionPlan({ folder: current, plan, selectedPaths });
  switch (result) {
  case 'changed': return result;
  case 'deleted': break;
  default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
  }
  try {
    await folder.getDirectoryHandle(leaf); await folder.removeEntry(leaf);
  } catch (error) {
    if (!(error instanceof DOMException && ['NotFoundError', 'InvalidModificationError', 'TypeMismatchError'].includes(error.name))) throw error;
  }
  return result;
}
export const TEST_ONLY = {
};
