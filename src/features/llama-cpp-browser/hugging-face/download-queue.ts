import { isHostDestination, destinationKey, hostModelRoot, modelDestinationSchema, type ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination';
import { shallowReadonly, shallowRef } from 'vue';
import { downloadRepository } from './download';
import { installedSelection } from './storage';
import { DownloadConflictError, selectionSchema, type DownloadConflict, type DownloadProgress, type DownloadSelection } from './types';
import { SuggestionPlanError } from './suggestion-plan';

export type DownloadJobStatus = 'queued' | 'resolving' | 'downloading' | 'pausing' | 'paused' | 'complete' | 'failed' | 'cancelled';
export type DownloadJobError = DownloadConflict | 'failed' | 'selection-unavailable';
export type DownloadJob = {
  id: number,
  key: string,
  repository: string,
  source: 'suggestion' | 'repository',
  destination: ModelDestination,
  status: DownloadJobStatus,
  selection: DownloadSelection | undefined,
  progress: DownloadProgress | undefined,
  error: DownloadJobError | undefined,
};
export function jobIsBusy({ job }: { job: DownloadJob | undefined }): boolean {
  const status = job?.status;
  switch (status) {
  case 'queued': case 'resolving': case 'downloading': case 'pausing': return true;
  case 'paused': case 'complete': case 'failed': case 'cancelled': case undefined: return false;
  default: { const exhaustive: never = status; throw new Error(String(exhaustive)); }
  }
}

type PrepareDownload = ({ signal }: { signal: AbortSignal }) => Promise<DownloadSelection>;
type DownloadTask = { root: Promise<{ handle: FileSystemDirectoryHandle } | { error: unknown }> | undefined, prepare: PrepareDownload, done: Promise<DownloadJob>, finish: ({ job }: { job: DownloadJob }) => void };

/**
 * One payload download per page, including the repository-input UI. The queue
 * and unresolved intents are memory-only. A reload loses waiting work; only
 * the existing writer's started-download journal survives for explicit resume.
 * Components may unmount without cancelling the user's download request.
 */
export function createDownloadQueue({ download }: { download: typeof downloadRepository }) {
  const jobs = shallowRef<DownloadJob[]>([]);
  const changed = shallowRef(0);
  const tasks = new Map<number, DownloadTask>();
  const boundRoots = new Map<number, FileSystemDirectoryHandle>();
  let sequence = 0;
  let running: { id: number, controller: AbortController } | undefined;
  function replace({ id, patch }: { id: number, patch: Partial<Pick<DownloadJob, 'status' | 'selection' | 'progress' | 'error'>> }): DownloadJob {
    const current = jobs.value.find(job => job.id === id);
    if (!current) throw new Error('Unknown download job');
    const next = { ...current, ...patch };
    jobs.value = jobs.value.map(job => job.id === id ? next : job);
    return next;
  }
  async function drain(): Promise<void> {
    if (running) return;
    const queued = jobs.value.find(job => job.status === 'queued');
    if (!queued) return;
    const task = tasks.get(queued.id)!;
    const controller = new AbortController();
    running = { id: queued.id, controller };
    try {
      replace({ id: queued.id, patch: { status: 'resolving' } });
      const root = await task.root;
      if (root && 'error' in root) throw root.error;
      if (root) boundRoots.set(queued.id, root.handle);
      controller.signal.throwIfAborted();
      const selection = selectionSchema.parse(await task.prepare({ signal: controller.signal }));
      controller.signal.throwIfAborted();
      replace({ id: queued.id, patch: { status: 'downloading', selection } });
      await download({
        selection,
        ...(isHostDestination(queued.destination) ? { destination: queued.destination, expectedRoot: root?.handle } : {}),
        signal: controller.signal,
        onProgress: ({ progress }) => {
          if (!controller.signal.aborted) replace({ id: queued.id, patch: { progress } });
        },
      });
      // A writer may finish concurrently with a pause. A committed success must
      // not become a phantom paused job with no journal to resume.
      replace({ id: queued.id, patch: { status: 'complete' } });
    } catch (error) {
      if (controller.signal.aborted) {
        const prepared = jobs.value.find(job => job.id === queued.id)?.selection;
        replace({ id: queued.id, patch: { status: prepared ? 'paused' : 'cancelled' } });
      } else {
        replace({ id: queued.id, patch: { status: 'failed', error: error instanceof DownloadConflictError ? error.reason : error instanceof SuggestionPlanError ? 'selection-unavailable' : 'failed' } });
      }
    } finally {
      changed.value++;
      task.finish({ job: jobs.value.find(job => job.id === queued.id)! });
      tasks.delete(queued.id);
      running = undefined;
      // Wait for writer cleanup before the next operation enters its lane.
      void drain();
    }
  }
  function enqueue({ key, repository, source, prepare, destination, expectedRoot }: { key: string, repository: string, source: DownloadJob['source'], prepare: PrepareDownload, destination?: ModelDestination, expectedRoot?: FileSystemDirectoryHandle }): { id: number, done: Promise<DownloadJob> } {
    const target = modelDestinationSchema.parse(destination ?? { kind: 'opfs' });
    key = downloadJobKey({ key, destination: target });
    const existing = jobs.value.find(job => job.key === key && jobIsBusy({ job }));
    if (existing) return { id: existing.id, done: tasks.get(existing.id)!.done };
    const previous = jobs.value.find(job => job.key === key);
    const boundRoot = (previous && previous.status !== 'complete' ? boundRoots.get(previous.id) : undefined) ?? expectedRoot;
    if (previous) boundRoots.delete(previous.id);
    const id = ++sequence;
    if (boundRoot) boundRoots.set(id, boundRoot);
    const deferred = Promise.withResolvers<DownloadJob>();
    // Capture physical identity before the queue waits on metadata or another job.
    const root = isHostDestination(target) ? hostModelRoot({ destination: target, mode: 'readwrite' }).then(async handle => {
      if (boundRoot && !await handle.isSameEntry(boundRoot)) return { error: new Error('Linked model folder changed during permission authorization') };
      return { handle: boundRoot ?? handle };
    }).catch(error => ({ error })) : undefined;
    tasks.set(id, { root, prepare, done: deferred.promise, finish: ({ job }) => deferred.resolve(job) });
    // Keep only the most recent terminal job for a key; no unbounded retry log.
    jobs.value = [...jobs.value.filter(job => job.key !== key), { id, key, repository, source, destination: target, status: 'queued', selection: undefined, progress: undefined, error: undefined }];
    // Queue the entire intent before discovery. Rapid clicks do not fan out
    // into metadata requests. Waiting host jobs read only their bound handle;
    // cancelled waiting work never opens or writes a model file.
    void Promise.resolve().then(drain);
    return { id, done: deferred.promise };
  }
  function cancel({ id }: { id: number }): void {
    const job = jobs.value.find(job => job.id === id);
    if (!job) return;
    switch (job.status) {
    case 'queued': {
      tasks.get(id)?.finish({ job: { ...job, status: 'cancelled' } });
      tasks.delete(id); boundRoots.delete(id); jobs.value = jobs.value.filter(entry => entry.id !== id); return;
    }
    case 'resolving': case 'downloading':
      replace({ id, patch: { status: 'pausing' } }); running?.controller.abort(); return;
    case 'pausing': case 'paused': case 'complete': case 'failed': case 'cancelled': return;
    default: { const exhaustive: never = job.status; throw new Error(String(exhaustive)); }
    }
  }
  function position({ id }: { id: number }): number | undefined {
    const index = jobs.value.filter(job => job.status === 'queued').findIndex(job => job.id === id);
    return index < 0 ? undefined : index + 1;
  }
  function forget({ id }: { id: number }): void {
    const job = jobs.value.find(entry => entry.id === id);
    if (jobIsBusy({ job })) return;
    boundRoots.delete(id); jobs.value = jobs.value.filter(entry => entry.id !== id);
  }
  async function stopDirectory({ directoryId }: { directoryId: string }): Promise<void> {
    const waiting: Promise<DownloadJob>[] = [];
    for (const job of jobs.value) {
      if (job.destination.kind !== 'host' || job.destination.directoryId !== directoryId || !jobIsBusy({ job })) continue;
      const task = tasks.get(job.id); if (task) waiting.push(task.done); cancel({ id: job.id });
    }
    await Promise.all(waiting);
  }
  return { jobs: shallowReadonly(jobs), changed: shallowReadonly(changed), enqueue, cancel, position, forget, stopDirectory };
}

export function downloadJobKey({ key, destination }: { key: string, destination?: ModelDestination }): string {
  const target = destinationKey({ destination });
  const suffix = `:destination:${target}`;
  return target === 'opfs' || key.endsWith(suffix) ? key : `${key}${suffix}`;
}
let queue: ReturnType<typeof createDownloadQueue> | undefined;
export function getDownloadQueue(): ReturnType<typeof createDownloadQueue> {
  queue ??= createDownloadQueue({
    download: async ({ selection, signal, onProgress, destination, expectedRoot }) => {
      signal.throwIfAborted();
      // Two explicitly queued entry points may target the same installed file set.
      // Local availability follows the same validated-file contract as the UI;
      // it is not a claim about remote revision/content equality.
      if (!isHostDestination(destination) && await installedSelection({ selection })) {
        signal.throwIfAborted(); return;
      }
      signal.throwIfAborted();
      await downloadRepository({ selection, signal, onProgress, ...(isHostDestination(destination) ? { destination, expectedRoot } : {}) });
    },
  });
  return queue;
}
export const TEST_ONLY = {
  reset: () => {
    queue = undefined;
  },
};
