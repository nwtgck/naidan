import { isHostDestination, destinationKey, hostModelRoot, modelDestinationSchema, type ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination';
import { shallowReadonly, shallowRef } from 'vue';
import { createDownloadManager, getDownloadManager, type DownloadManager } from '@/logic/download-manager';
import { downloadFilesForDisplay } from '@/logic/hugging-face-download/presentation';
import { awaitInspection } from '@/logic/model-file-inspection/abort';
import type { ManagedDownloadStatus } from '@/01-models/download';
import { downloadRepository } from './download';
import { DownloadConflictError, selectionSchema, type DownloadConflict, type DownloadProgress, type DownloadSelection } from './types';
import { SuggestionPlanError } from './suggestion-plan';
import { selectionKey } from './download-plan';

export type DownloadJobStatus = 'queued' | 'resolving' | 'downloading' | 'pausing' | 'paused' | 'complete' | 'failed' | 'cancelled';
export type DownloadJobError = DownloadConflict | 'failed' | 'selection-unavailable';
export type DownloadJob = {
  id: number, key: string, repository: string, source: 'suggestion' | 'repository', destination: ModelDestination,
  status: DownloadJobStatus, selection: DownloadSelection | undefined, progress: DownloadProgress | undefined, error: DownloadJobError | undefined,
};

export function jobIsBusy({ job }: { job: DownloadJob | undefined }): boolean {
  const status = job?.status;
  switch (status) {
  case 'queued': case 'resolving': case 'downloading': case 'pausing': return true;
  case 'paused': case 'complete': case 'failed': case 'cancelled': case undefined: return false;
  default: {
    const exhaustive: never = status;
    throw new Error(String(exhaustive));
  }
  }
}

function jobIsComplete({ job }: { job: DownloadJob | undefined }): boolean {
  const status = job?.status;
  switch (status) {
  case 'complete': return true;
  case 'queued': case 'resolving': case 'downloading': case 'pausing': case 'paused': case 'failed': case 'cancelled': case undefined: return false;
  default: {
    const exhaustive: never = status;
    throw new Error(String(exhaustive));
  }
  }
}

type PrepareDownload = ({ signal }: { signal: AbortSignal }) => Promise<DownloadSelection>;
type Binding = { job: DownloadJob, root: FileSystemDirectoryHandle | undefined, done: Promise<DownloadJob> };

function legacyStatus({ status, prepared }: { status: ManagedDownloadStatus, prepared: boolean }): DownloadJobStatus {
  switch (status) {
  case 'cancelling': return 'pausing';
  case 'paused': return prepared ? 'paused' : 'cancelled';
  case 'queued': case 'resolving': case 'downloading': case 'pausing': case 'complete': case 'failed': case 'cancelled': return status;
  default: {
    const exhaustive: never = status;
    throw new Error(String(exhaustive));
  }
  }
}

/** Existing model screens subscribe to the shared manager through this facade.
 * They neither own a second scheduler nor keep a view mounted to execute work. */
export function createDownloadQueue({ download, manager: suppliedManager }: { download: typeof downloadRepository, manager?: DownloadManager }) {
  const manager = suppliedManager ?? createDownloadManager();
  const jobs = shallowRef<DownloadJob[]>([]);
  const changed = shallowRef(0);
  const bindings = new Map<number, Binding>();
  function synchronize(): void {
    const states = new Map(manager.snapshot().map(job => [job.id, job]));
    for (const [id, binding] of bindings) {
      const current = states.get(id);
      if (!current) {
        // Another view or the shared download panel can retire this job.
        // Keeping its old binding would render an orphaned retry control.
        bindings.delete(id);
        if (binding.job.selection) {
          changed.value++;
        }
        continue;
      }
      const status = legacyStatus({ status: current.status, prepared: binding.job.selection !== undefined });
      if (jobIsBusy({ job: binding.job }) && !jobIsBusy({ job: { ...binding.job, status } })) {
        changed.value++;
      }
      binding.job = { ...binding.job, status };
    }
    jobs.value = [...bindings.values()].map(binding => binding.job);
  }
  manager.subscribe({ listener: synchronize });
  function enqueue({ key, repository, source, prepare, destination, expectedRoot }: {
    key: string, repository: string, source: DownloadJob['source'], prepare: PrepareDownload, destination?: ModelDestination, expectedRoot?: FileSystemDirectoryHandle,
  }): { id: number, done: Promise<DownloadJob> } {
    const target = modelDestinationSchema.parse(destination ?? { kind: 'opfs' });
    key = downloadJobKey({ key, destination: target });
    const existing = [...bindings.values()].find(binding => binding.job.key === key
      || binding.job.selection !== undefined && downloadJobKey({ key: selectionKey({ selection: binding.job.selection }), destination: binding.job.destination }) === key);
    if (existing && jobIsBusy({ job: existing.job })) {
      return { id: existing.job.id, done: manager.wait({ id: existing.job.id })?.then(result => ({ ...existing.job, status: legacyStatus({ status: result.status, prepared: existing.job.selection !== undefined }) })) ?? existing.done };
    }
    const boundRoot = (!jobIsComplete({ job: existing?.job }) ? existing?.root : undefined) ?? expectedRoot;
    if (existing) {
      bindings.delete(existing.job.id);
      if (!jobIsComplete({ job: existing.job })) {
        void manager.remove({ id: existing.job.id });
      }
    }
    // Authorize/capture the physical root at the click, before waiting in the queue.
    const authorize = ({ expected }: { expected: FileSystemDirectoryHandle | undefined }) => isHostDestination(target) ? hostModelRoot({ destination: target, mode: 'readwrite' }).then(async handle => {
      if (expected && !await handle.isSameEntry(expected)) {
        throw new Error('Linked model folder changed during permission authorization');
      }
      return { handle: expected ?? handle };
    }).catch(error => ({ error })) : Promise.resolve(undefined);
    let root = authorize({ expected: boundRoot });
    // eslint-disable-next-line prefer-const -- The run closure is registered before its returned job id can initialize this binding.
    let binding: Binding;
    const managed = manager.enqueue({
      key: `llama:${key}`,
      title: repository,
      category: 'language-model',
      destination: target,
      files: [],
      onResume: () => {
        root = authorize({ expected: binding.root ?? boundRoot });
      },
      run: async ({ execution }) => {
        const { signal } = execution;
        try {
          const authorized = await awaitInspection({ task: root, signal });
          if (authorized && 'error' in authorized) {
            throw authorized.error;
          }
          binding.root = authorized?.handle;
          if (isHostDestination(target) && binding.root) {
            const current = await hostModelRoot({ destination: target, mode: 'readwrite' });
            if (!await current.isSameEntry(binding.root)) {
              throw new Error('Linked model folder changed after this download was queued');
            }
          }
          const selection = selectionSchema.parse(await awaitInspection({ task: prepare({ signal }), signal }));
          signal.throwIfAborted();
          binding.job = { ...binding.job, selection, progress: undefined, error: undefined };
          execution.setFiles({ files: downloadFilesForDisplay({ files: selection.files.map(file => ({ ...file, repository: selection.repository, revision: selection.revision })), destination: target, rootName: binding.root?.name }) });
          await download({
            selection,
            signal,
            ...(isHostDestination(target) ? { destination: target, expectedRoot: binding.root } : {}),
            onProgress: ({ progress }) => {
              if (signal.aborted) {
                return;
              }
              binding.job = { ...binding.job, progress };
              for (const [index, file] of progress.fileProgress?.entries() ?? []) {
                execution.reportFile({ index, patch: { size: file.total, completed: file.completed, state: file.state } });
              }
              synchronize();
            },
          });
        } catch (error) {
          binding.job = { ...binding.job, error: signal.aborted ? undefined : error instanceof DownloadConflictError ? error.reason : error instanceof SuggestionPlanError ? 'selection-unavailable' : 'failed' };
          throw error;
        }
      },
    });
    const done = managed.done.then(result => {
      synchronize();
      return { ...binding.job, status: legacyStatus({ status: result.status, prepared: binding.job.selection !== undefined }) };
    });
    binding = { job: { id: managed.id, key, repository, source, destination: target, status: 'queued', selection: undefined, progress: undefined, error: undefined }, root: boundRoot, done };
    bindings.set(managed.id, binding);
    synchronize();
    return { id: managed.id, done };
  }
  function cancel({ id }: { id: number }): void {
    const binding = bindings.get(id);
    if (!binding) {
      return;
    }
    switch (binding.job.status) {
    case 'queued':
      void manager.remove({ id });
      bindings.delete(id);
      synchronize();
      break;
    case 'resolving': case 'downloading': case 'pausing': manager.pause({ id });
      break;
    case 'paused': case 'failed': case 'complete': case 'cancelled': break;
    default: {
      const exhaustive: never = binding.job.status;
      throw new Error(String(exhaustive));
    }
    }
  }
  function forget({ id }: { id: number }): void {
    if (jobIsBusy({ job: bindings.get(id)?.job })) {
      return;
    }
    void manager.remove({ id });
    bindings.delete(id);
    synchronize();
  }
  return { jobs: shallowReadonly(jobs), changed: shallowReadonly(changed), enqueue, cancel, position: manager.position, forget, stopDirectory: manager.stopDirectory };
}

export function downloadJobKey({ key, destination }: { key: string, destination?: ModelDestination }): string {
  const target = destinationKey({ destination });
  const suffix = `:destination:${target}`;
  return target === 'opfs' || key.endsWith(suffix) ? key : `${key}${suffix}`;
}

let queue: ReturnType<typeof createDownloadQueue> | undefined;

export function getDownloadQueue(): ReturnType<typeof createDownloadQueue> {
  queue ??= createDownloadQueue({ download: downloadRepository, manager: getDownloadManager() });
  return queue;
}

export const TEST_ONLY = {
  reset() {
    queue = undefined;
    const manager = getDownloadManager();
    for (const job of manager.snapshot()) {
      void manager.remove({ id: job.id });
    }
  },
};
