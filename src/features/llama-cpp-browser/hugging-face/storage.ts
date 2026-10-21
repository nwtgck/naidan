import { hostDownloadMarker } from './host-download-marker';
import { isHostDestination, hostModelRoot, type ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination';
import { formatHuggingFaceModelId } from '@/01-models/llama-cpp-browser-model-id';
import { storageService } from '@/00-storage/service';
import { idToRaw, type HostModelDirectoryId } from '@/01-models/ids';
import { formatHostModelId } from '@/features/llama-cpp-browser/runtime/host-model-aliases';
import { OPFS_MODELS_DIR } from '@/constants';
import { rankedProjectors } from './presentation';
import { modelGroups, modelVariantName } from './model-variants';
import { selectRepositoryModel } from './model-selector';
export { selectRepositoryModel } from './model-selector';
import { deletionPlanSchema, executeDeletionPlan, pruneCapturedModelRoot, type DeletionPlan, type DeletionResult } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { describeDirectory, opfsRoot, readModelFiles, resolveModelFiles, modelDirectory, validGguf, type ModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import { LlamaCppBrowserError, type LocalModel } from '@/features/llama-cpp-browser/types';
import { journalSchema, pendingName, repositorySchema, type DownloadJournal, type DownloadSelection } from './types';

export function isMissing({ error }: { error: unknown }): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

export async function repositoryFolder({ repository, create, destination }: { repository: string, create: boolean, destination?: ModelDestination }): Promise<FileSystemDirectoryHandle> {
  const [owner, repo] = repositorySchema.parse(repository).split('/');
  let folder = isHostDestination(destination) ? await hostModelRoot({ destination, mode: create ? 'readwrite' : 'read' }) : await opfsRoot();
  const path = isHostDestination(destination) ? [owner!, repo!] : [OPFS_MODELS_DIR, 'huggingface.co', owner!, repo!, 'resolve', 'main'];
  for (const name of path) {
    folder = await folder.getDirectoryHandle(name, { create });
  }
  return folder;
}

export async function selectedFile({ folder, path, create }: { folder: FileSystemDirectoryHandle, path: string, create: boolean }): Promise<FileSystemFileHandle> {
  const parts = path.split('/');
  const name = parts.pop()!;
  for (const part of parts) {
    folder = await folder.getDirectoryHandle(part, { create });
  }
  return folder.getFileHandle(name, { create });
}

export async function readJournal({ folder }: { folder: FileSystemDirectoryHandle }): Promise<DownloadJournal> {
  const file = await (await folder.getFileHandle(pendingName)).getFile();
  if (file.size > 4 * 1024 * 1024) {
    throw new Error('Download journal exceeds the size limit');
  }
  return journalSchema.parse(JSON.parse(await file.text()));
}

export async function writeJournal({ folder, journal }: { folder: FileSystemDirectoryHandle, journal: DownloadJournal }): Promise<void> {
  const writer = await (await folder.getFileHandle(pendingName, { create: true })).createWritable();
  try {
    await writer.write(JSON.stringify(journalSchema.parse(journal)));
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

export async function visitRepositories({ visit, destination, onIssue }: { destination?: ModelDestination, onIssue?: ({ repository, error }: { repository: string, error: unknown }) => void, visit: ({ repository, folder }: { repository: string, folder: FileSystemDirectoryHandle }) => Promise<void> }): Promise<void> {
  let host: FileSystemDirectoryHandle;
  try {
    host = isHostDestination(destination) ? await hostModelRoot({ destination, mode: 'read' }) : await (await (await opfsRoot()).getDirectoryHandle(OPFS_MODELS_DIR)).getDirectoryHandle('huggingface.co');
  } catch (error) {
    if (isMissing({ error })) {
      return;
    }
    throw error;
  }
  for await (const [owner, ownerFolder] of host.entries()) {
    switch (ownerFolder.kind) {
    case 'file': continue;
    case 'directory': break;
    default: {
      const exhaustive: never = ownerFolder;
      throw new Error(String(exhaustive));
    }
    }
    for await (const [repo, repoFolder] of ownerFolder.entries()) {
      switch (repoFolder.kind) {
      case 'file': continue;
      case 'directory': break;
      default: {
        const exhaustive: never = repoFolder;
        throw new Error(String(exhaustive));
      }
      }
      const repository = `${owner}/${repo}`;
      if (!repositorySchema.safeParse(repository).success) {
        continue;
      }
      try {
        await visit({ repository, folder: isHostDestination(destination) ? repoFolder : await (await repoFolder.getDirectoryHandle('resolve')).getDirectoryHandle('main') });
      } catch (error) {
        if (!isMissing({ error })) {
          if (onIssue) {
            onIssue({ repository, error });
          } else {
            throw error;
          }
        }
      }
    }
  }
}

async function repositoryFiles({ repository, destination, signal }: { repository: string, destination: ModelDestination | undefined, signal: AbortSignal | undefined }): Promise<ModelDirectory['files']> {
  const folder = await repositoryFolder({ repository, create: false, destination });
  let pending: DownloadJournal | undefined;
  try {
    pending = await readJournal({ folder });
  } catch (error) {
    if (!isMissing({ error })) {
      throw error;
    }
  }
  const hidden = new Set(pending?.selection.files.filter((_file, index) => !pending?.reused?.[index]).map(file => file.path));
  return (await readModelFiles({ folder, prefix: '', storageKind: isHostDestination(destination) ? 'host' : 'opfs', signal })).filter(file => !hidden.has(file.relativePath));
}

export async function repositoryDirectories({ repository, destination, signal }: { repository: string, destination?: ModelDestination, signal?: AbortSignal }): Promise<ModelDirectory[]> {
  return describeRepositoryDirectories({ actual: await repositoryFiles({ repository, destination, signal }), onlyPrimaryRelativePath: undefined, signal });
}

async function describeRepositoryDirectories({ actual, onlyPrimaryRelativePath, signal }: { actual: ModelDirectory['files'], onlyPrimaryRelativePath: string | undefined, signal: AbortSignal | undefined }): Promise<ModelDirectory[]> {
  const { models, projectors } = modelGroups({ files: actual });
  const result: ModelDirectory[] = [];
  const projector = rankedProjectors({ files: projectors.map(entry => ({ path: entry.relativePath, entry })) })[0]?.entry;
  for (const group of models) {
    signal?.throwIfAborted();
    const files = [...group, ...projector ? [projector] : []];
    try {
      const directory = modelDirectory({ files });
      // Launch readiness checks the requested file, keeping the inventory's
      // grouping and projector selection without reading every variant header.
      if (onlyPrimaryRelativePath !== undefined && directory.primaryFile.relativePath !== onlyPrimaryRelativePath) {
        continue;
      }
      if (await allValid({ files })) {
        result.push(directory);
      }
    } catch (error) {
      if (!(error instanceof LlamaCppBrowserError)) {
        throw error;
      }
    }
  }
  signal?.throwIfAborted();
  return result;
}

type HostDirectories = readonly { id: HostModelDirectoryId, name: string }[];

function describeRepositoryModel({ directory, repository, destination, directories }: { directory: ModelDirectory, repository: string, destination: ModelDestination | undefined, directories: HostDirectories }): LocalModel {
  if (!isHostDestination(destination)) {
    return describeDirectory({ directory, modelId: formatHuggingFaceModelId({ repository, mainFilePath: directory.primaryFile.relativePath }) });
  }
  const registration = directories.find(entry => idToRaw({ id: entry.id }) === destination.directoryId);
  if (!registration) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  return {
    ...describeDirectory({ directory, modelId: formatHostModelId({ directoryId: destination.directoryId, repository, primaryRelativePath: directory.primaryFile.relativePath, directories }) }),
    source: { kind: 'host', directoryId: destination.directoryId, directoryName: registration.name, repository, primaryRelativePath: directory.primaryFile.relativePath },
  };
}

export async function installedSelection({ selection, destination }: { selection: DownloadSelection, destination?: ModelDestination }): Promise<LocalModel | undefined> {
  let actual: ModelDirectory['files'];
  try {
    actual = await repositoryFiles({ repository: selection.repository, destination, signal: undefined });
  } catch (error) {
    if (isMissing({ error })) {
      return undefined;
    }
    throw error;
  }
  const selectedFiles: ModelDirectory['files'] = [];
  for (const expected of selection.files) {
    const found = actual.find(file => file.relativePath === expected.path && file.file.size === expected.size);
    if (!found) {
      return undefined;
    }
    selectedFiles.push(found);
  }
  if (!await allValid({ files: selectedFiles })) {
    return undefined;
  }
  const requested = resolveModelFiles({ files: selection.files.map(file => ({ relativePath: file.path })) });
  const directories = await describeRepositoryDirectories({ actual, onlyPrimaryRelativePath: requested.primaryRelativePath, signal: undefined });
  const directory = directories.find(model => model.primaryFile.relativePath === requested.primaryRelativePath);
  if (!directory) {
    return undefined;
  }
  // Most launches inspect only the requested headers. If group names collide,
  // apply the same complete/header admission as listing and resolution before
  // deciding whether the readable modelId identifies the requested files.
  const candidates = modelGroups({ files: actual }).models.map(group => ({ primaryFile: { relativePath: group[0]!.relativePath } }));
  const modelId = formatHuggingFaceModelId({ repository: selection.repository, mainFilePath: requested.primaryRelativePath });
  const variant = parseModelReference({ modelId }).variant;
  try {
    const matching = candidates.filter(candidate => modelVariantName({ repository: selection.repository, path: candidate.primaryFile.relativePath }) === variant);
    const admitted = matching.length > 1 ? await repositoryDirectories({ repository: selection.repository, destination }) : candidates;
    const selected = selectRepositoryModel({ models: admitted, repository: selection.repository, variant });
    if (selected.primaryFile.relativePath !== requested.primaryRelativePath) {
      return undefined;
    }
  } catch (error) {
    if (error instanceof LlamaCppBrowserError) {
      return undefined;
    }
    throw error;
  }
  return describeRepositoryModel({ directory, repository: selection.repository, destination, directories: isHostDestination(destination) ? await storageService.loadHostModelDirectories() : [] });
}

async function allValid({ files }: { files: ModelDirectory['files'] }): Promise<boolean> {
  for (const entry of files) {
    if (!await validGguf({ file: entry.file })) {
      return false;
    }
  }
  return true;
}

export function parseModelReference({ modelId }: { modelId: string }): { repository: string, variant: string | undefined } {
  if (!modelId.startsWith('hf.co/')) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  const value = modelId.slice('hf.co/'.length);
  const colon = value.indexOf(':');
  return { repository: repositorySchema.parse(colon < 0 ? value : value.slice(0, colon)), variant: colon < 0 ? undefined : value.slice(colon + 1) };
}

export async function resolveRepositoryModel({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<ModelDirectory> {
  const { repository, variant } = parseModelReference({ modelId });
  if (variant === undefined) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  return selectRepositoryModel({ models: await repositoryDirectories({ repository, signal }), repository, variant });
}

export async function listHuggingFaceModels({ destination, onIssue, directories, signal }: { destination?: ModelDestination, onIssue?: ({ repository, error }: { repository: string, error: unknown }) => void, directories?: HostDirectories, signal?: AbortSignal } = {}): Promise<LocalModel[]> {
  const result: LocalModel[] = [];
  const registrations = directories ?? (isHostDestination(destination) ? await storageService.loadHostModelDirectories() : []);
  await visitRepositories({
    destination,
    onIssue,
    visit: async ({ repository }) => {
      const models = await repositoryDirectories({ repository, destination, signal });
      for (const directory of models) {
        const entry = describeRepositoryModel({ directory, repository, destination, directories: registrations });
        // Current literal readable IDs form one namespace. An ambiguous group
        // is hidden rather than selected by inventory order.
        if (models.filter(candidate => describeRepositoryModel({ directory: candidate, repository, destination, directories: registrations }).modelId === entry.modelId).length === 1) {
          result.push(entry);
        }
      }
    },
  });
  signal?.throwIfAborted();
  return result;
}

export async function listPendingDownloads({ destination }: { destination?: ModelDestination } = {}): Promise<DownloadJournal[]> {
  const result: DownloadJournal[] = [];
  await visitRepositories({
    destination,
    visit: async ({ repository, folder }) => {
      const journal = await readJournal({ folder });
      if (journal.selection.repository !== repository) {
        throw new Error('Download journal repository mismatch');
      }
      result.push(journal);
    },
  });
  return result;
}

export async function withRepositoryLock<T>({ repository, operation }: { repository: string, operation: () => Promise<T> }): Promise<T> {
  repositorySchema.parse(repository);
  if (!navigator.locks) {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  return navigator.locks.request(`naidan-llama-cpp-browser-hf:${repository}`, { ifAvailable: true }, lock => {
    if (!lock) {
      throw new LlamaCppBrowserError({ code: 'busy' });
    }
    return operation();
  });
}

export async function deleteRepository({ repository, plan, destination }: { repository: string, plan: DeletionPlan, destination?: ModelDestination }): Promise<DeletionResult> {
  plan = deletionPlanSchema.parse(plan);
  const location = plan.target.location;
  if (location.kind === 'opfs-user' || location.repository !== repository || (isHostDestination(destination) ? location.kind !== 'host' || location.directoryId !== destination.directoryId : location.kind !== 'hugging-face')) {
    throw new Error('Deletion plan does not match the repository');
  }
  switch (plan.target.kind) {
  case 'model': break;
  case 'repository': {
    let journal: DownloadJournal | undefined;
    try {
      journal = await readJournal({ folder: plan.folder });
    } catch (error) {
      if (!isMissing({ error })) {
        throw error;
      }
    }
    if (JSON.stringify(journal) !== JSON.stringify(plan.target.journal)) {
      return 'changed';
    }
    if (journal && location.kind === 'host') {
      for (let index = 0; index < journal.selection.files.length; index++) {
        if (!journal.reused?.[index]) {
          await hostDownloadMarker({ folder: plan.folder, selection: journal.selection, index, action: 'check' });
        }
      }
    }
    break;
  }
  default: {
    const exhaustive: never = plan.target;
    throw new Error(String(exhaustive));
  }
  }
  const result = await executeDeletionPlan({ folder: plan.folder, files: plan.files, selectedRelativePaths: plan.selectedRelativePaths });
  switch (result) {
  case 'deleted': await pruneCapturedModelRoot({ plan });
    return result;
  case 'changed': return result;
  default: {
    const exhaustive: never = result;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
