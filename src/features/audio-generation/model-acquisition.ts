import { awaitInspection } from '@/logic/model-file-inspection/abort';
import { findModelDownloadJob, getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { repositoryDefaultDownloadKey } from '@/features/llama-cpp-browser/hugging-face/repository-row-download';
import { quantizationName } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { findLocalSuggestedModel } from '@/features/llama-cpp-browser/hugging-face/suggestion-plan';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { targetForSelection } from '@/features/llama-cpp-browser/model-launch/target';
import { selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import type { DownloadSelection } from '@/features/llama-cpp-browser/hugging-face/types';
import { repositoryModelDownloadIdentity, resolveBundledRepositoryTarget, type RepositoryModelSelection } from '@/features/llama-cpp-browser/model-launch/bundled-repository-target';
import { LlamaCppBrowserError, type LocalModel } from '@/features/llama-cpp-browser/types';

export function audioSearchDownloadKey({ selection }: { selection: RepositoryModelSelection }): string | undefined {
  const { source, defaultDownloadKey } = selection;
  if (defaultDownloadKey !== undefined) {
    return defaultDownloadKey;
  }
  switch (source.kind) {
  case 'bundled': return repositoryDefaultDownloadKey({ repository: source.repository, usage: 'audio-generation' });
  case 'resolved': return undefined;
  default: throw new Error(String(source satisfies never));
  }
}

export function matchesAudioDownload({ selection, files }: { selection: RepositoryModelSelection, files: DownloadSelection | undefined }): boolean {
  if (files === undefined) {
    return false;
  }
  const { source } = selection;
  switch (source.kind) {
  case 'resolved': return selectionKey({ selection: files }) === selectionKey({ selection: source.target.selection });
  case 'bundled': {
    if (files.repository.toLowerCase() !== source.repository.toLowerCase()) {
      return false;
    }
    try {
      const { mainFilePath } = targetForSelection({ selection: files });
      return quantizationName({ path: mainFilePath }) === source.variant
        && (source.companionPath === undefined || files.files.some(file => file.path === source.companionPath));
    } catch {
      return false;
    }
  }
  default: throw new Error(String(source satisfies never));
  }
}

/** The caller invokes this from Generate, while linked-folder permission can still be requested. */
export async function acquireAudioModel({ selection, models, signal, onDownload }: {
  selection: RepositoryModelSelection,
  models: readonly LocalModel[],
  signal: AbortSignal,
  onDownload({ id }: { id: number }): void,
}): Promise<LocalModel> {
  signal.throwIfAborted();
  const { source, authorizeDestination } = selection;
  const requestedDestination = selection.destination;
  const queue = getDownloadQueue();
  const { key, selection: resolved } = repositoryModelDownloadIdentity({ source });
  const previous = findModelDownloadJob({ jobs: queue.jobs.value, key, selection: resolved, destination: requestedDestination });
  const prepared = resolved ?? previous?.selection;
  const host = requestedDestination.kind === 'host';
  // The cached handle must request permission during the Generate gesture.
  // Keep denial pending until we know the model really needs to be written.
  const authorization = authorizeDestination?.({ destination: requestedDestination }).then(
    authorized => ({ authorized, error: undefined }),
    (error: unknown) => ({ authorized: undefined, error }),
  );

  async function findInstalled({ expectedRoot }: { expectedRoot: FileSystemDirectoryHandle | undefined }): Promise<LocalModel | undefined> {
    if (prepared !== undefined) {
      const model = await awaitInspection({ task: installedSelection({ selection: prepared, destination: requestedDestination, expectedRoot }), signal });
      if (model !== undefined) {
        return model;
      }
    }
    switch (source.kind) {
    case 'bundled': {
      const model = findLocalSuggestedModel({
        quantization: { hfRepository: source.repository, preferredQuantization: source.variant },
        models,
        destination: requestedDestination,
      });
      if (model !== undefined) {
        const stored = await awaitInspection({ task: llamaCppBrowserModelFiles.inspectModelFiles({ modelId: model.modelId, signal }), signal }).catch(() => undefined);
        signal.throwIfAborted();
        if (stored !== undefined && (source.companionPath === undefined || stored.directory.projectorFile !== undefined)) {
          return model;
        }
      }
      return undefined;
    }
    case 'resolved': return undefined;
    default: throw new Error(String(source satisfies never));
    }
  }

  // An expired read grant should let the permission request finish, then retry.
  const local = await findInstalled({ expectedRoot: undefined }).catch((error: unknown) => {
    signal.throwIfAborted();
    if (!host) {
      throw error;
    }
    return undefined;
  });
  if (local !== undefined) {
    return local;
  }
  if (host && authorization === undefined) {
    throw new LlamaCppBrowserError({ code: 'storage-error' });
  }
  let destination = requestedDestination;
  let expectedRoot: FileSystemDirectoryHandle | undefined;
  if (authorization !== undefined) {
    const { authorized, error } = await awaitInspection({ task: authorization, signal });
    if (authorized === undefined) {
      throw error;
    }
    ({ destination, expectedRoot } = authorized);
  }
  if (host) {
    const model = await findInstalled({ expectedRoot });
    if (model !== undefined) {
      return model;
    }
  }

  async function prepare({ signal }: { signal: AbortSignal }): Promise<DownloadSelection> {
    if (prepared !== undefined) {
      return prepared;
    }
    switch (source.kind) {
    case 'bundled': return (await resolveBundledRepositoryTarget({ ...source, signal })).selection;
    case 'resolved': return source.target.selection;
    default: throw new Error(String(source satisfies never));
    }
  }

  async function waitForDownload({ jobKey, repository }: { jobKey: string, repository: string }): Promise<DownloadSelection> {
    signal.throwIfAborted();
    const job = queue.enqueue({ key: jobKey, repository, source: 'repository', destination, expectedRoot, prepare });
    onDownload({ id: job.id });
    // Cancelling generation only stops this view's wait. The shared download can
    // be resumed or used by other views from the download manager.
    const result = await awaitInspection({ task: job.done, signal });
    signal.throwIfAborted();
    switch (result.status) {
    case 'complete':
      if (result.selection !== undefined) {
        return result.selection;
      }
      break;
    case 'queued': case 'resolving': case 'downloading': case 'pausing': case 'paused': case 'failed': case 'cancelled': break;
    default: throw new Error(String(result.status satisfies never));
    }
    throw new LlamaCppBrowserError({ code: 'storage-error' });
  }

  const repository = (() => {
    switch (source.kind) {
    case 'bundled': return source.repository;
    case 'resolved': return source.target.selection.repository;
    default: throw new Error(String(source satisfies never));
    }
  })();
  const searchDownloadKey = audioSearchDownloadKey({ selection });
  if (searchDownloadKey !== undefined && !jobIsBusy({ job: previous })) {
    const existing = findModelDownloadJob({ jobs: queue.jobs.value, key: searchDownloadKey, destination, selection: undefined });
    // Search defaults can resolve to a different quantization in the same repo.
    // Only attach once the manager has confirmed the requested files.
    if (jobIsBusy({ job: existing }) && matchesAudioDownload({ selection, files: existing?.selection })) {
      const downloaded = await waitForDownload({ jobKey: searchDownloadKey, repository });
      if (matchesAudioDownload({ selection, files: downloaded })) {
        const model = await awaitInspection({ task: installedSelection({ selection: downloaded, destination, expectedRoot }), signal });
        signal.throwIfAborted();
        if (model !== undefined) {
          return model;
        }
      }
    }
  }
  const downloaded = await waitForDownload({ jobKey: key, repository });
  if (prepared !== undefined && selectionKey({ selection: downloaded }) !== selectionKey({ selection: prepared })) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  const model = await awaitInspection({ task: installedSelection({ selection: downloaded, destination, expectedRoot }), signal });
  signal.throwIfAborted();
  if (model === undefined) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  return model;
}

export const TEST_ONLY = {
};
