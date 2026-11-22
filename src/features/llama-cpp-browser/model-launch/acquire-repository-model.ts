import { awaitInspection } from '@/logic/model-file-inspection/abort';
import { findModelDownloadJob, getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { repositoryDefaultDownloadKey, type RepositoryDownloadUsage } from '@/features/llama-cpp-browser/hugging-face/repository-row-download';
import { quantizationName } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { findLocalSuggestedModel } from '@/features/llama-cpp-browser/hugging-face/suggestion-plan';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { targetForSelection } from '@/features/llama-cpp-browser/model-launch/target';
import { selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { installedRepositoryVariant, installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import type { DownloadSelection } from '@/features/llama-cpp-browser/hugging-face/types';
import { repositoryModelDownloadIdentity, resolveBundledRepositoryTarget, type RepositoryModelSelection } from '@/features/llama-cpp-browser/model-launch/bundled-repository-target';
import { isHostDestination, type ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination';
import { LlamaCppBrowserError, type LocalModel } from '@/features/llama-cpp-browser/types';

export function repositorySearchDownloadKey({ selection, usage }: { selection: RepositoryModelSelection, usage: RepositoryDownloadUsage }): string | undefined {
  const { source, defaultDownloadKey } = selection;
  if (defaultDownloadKey !== undefined) {
    return defaultDownloadKey;
  }
  switch (source.kind) {
  case 'bundled': return repositoryDefaultDownloadKey({ repository: source.repository, usage });
  case 'resolved': return undefined;
  default: throw new Error(String(source satisfies never));
  }
}

export function matchesRepositoryDownload({ selection, files }: { selection: RepositoryModelSelection, files: DownloadSelection | undefined }): boolean {
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

/** Invoke from the user's action so linked-folder permission can still be requested. */
export async function acquireRepositoryModel({ selection, usage, models, capturedRoot, signal, onDownload }: {
  selection: RepositoryModelSelection,
  usage: RepositoryDownloadUsage,
  models: readonly LocalModel[],
  capturedRoot: FileSystemDirectoryHandle | undefined,
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
  const host = isHostDestination(requestedDestination);
  // The cached handle must request permission during the initiating gesture.
  // Keep denial pending until we know the model really needs to be written.
  const authorization = authorizeDestination?.({ destination: requestedDestination }).then(
    authorized => ({ authorized, error: undefined }),
    (error: unknown) => ({ authorized: undefined, error }),
  );

  function findPrepared({ destination, expectedRoot }: { destination: ModelDestination, expectedRoot: FileSystemDirectoryHandle | undefined }): Promise<LocalModel | undefined> {
    return prepared === undefined ? Promise.resolve(undefined)
      : awaitInspection({ task: installedSelection({ selection: prepared, destination, expectedRoot }), signal });
  }

  function recheckHostVariant({ destination, expectedRoot }: { destination: Extract<ModelDestination, { kind: 'host' }>, expectedRoot: FileSystemDirectoryHandle | undefined }): Promise<LocalModel | undefined> {
    switch (source.kind) {
    case 'bundled': return awaitInspection({
      task: installedRepositoryVariant({
        repository: source.repository,
        variant: source.variant,
        requireProjector: source.companionPath !== undefined,
        destination,
        expectedRoot,
        signal,
      }),
      signal,
    });
    case 'resolved': return Promise.resolve(undefined);
    default: throw new Error(String(source satisfies never));
    }
  }

  async function findInstalled(): Promise<LocalModel | undefined> {
    const preparedModel = await findPrepared({ destination: requestedDestination, expectedRoot: capturedRoot });
    if (preparedModel !== undefined) {
      return preparedModel;
    }
    switch (source.kind) {
    case 'bundled': {
      const model = findLocalSuggestedModel({
        quantization: { hfRepository: source.repository, preferredQuantization: source.variant },
        models,
        destination: requestedDestination,
      });
      if (model !== undefined) {
        if (isHostDestination(requestedDestination)) {
          return recheckHostVariant({ destination: requestedDestination, expectedRoot: capturedRoot });
        }
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
  // For readable host folders, the local hit must still match the handle
  // captured during the gesture, even if write permission is denied.
  const local = host && capturedRoot === undefined ? undefined : await findInstalled().catch((error: unknown) => {
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
  let expectedRoot = capturedRoot;
  if (authorization !== undefined) {
    const { authorized, error } = await awaitInspection({ task: authorization, signal });
    if (authorized === undefined) {
      throw error;
    }
    destination = authorized.destination;
    expectedRoot ??= authorized.expectedRoot;
  }
  if (isHostDestination(destination)) {
    const model = await findPrepared({ destination, expectedRoot });
    if (model !== undefined) {
      return model;
    }
    // The inventory may have omitted this folder before authorization.
    // Recheck its files before making a Hugging Face request.
    const installed = await recheckHostVariant({ destination, expectedRoot });
    if (installed !== undefined) {
      return installed;
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
    // Cancellation only stops this view's wait. The shared download can
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
  const searchDownloadKey = repositorySearchDownloadKey({ selection, usage });
  if (searchDownloadKey !== undefined && !jobIsBusy({ job: previous })) {
    const existing = findModelDownloadJob({ jobs: queue.jobs.value, key: searchDownloadKey, destination, selection: undefined });
    // Search defaults can resolve to a different quantization in the same repo.
    // Only attach once the manager has confirmed the requested files.
    if (jobIsBusy({ job: existing }) && matchesRepositoryDownload({ selection, files: existing?.selection })) {
      const downloaded = await waitForDownload({ jobKey: searchDownloadKey, repository });
      if (matchesRepositoryDownload({ selection, files: downloaded })) {
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
