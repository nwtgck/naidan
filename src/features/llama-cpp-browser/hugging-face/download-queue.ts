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
type DownloadTask = { prepare: PrepareDownload, done: Promise<DownloadJob>, finish: ({ job }: { job: DownloadJob }) => void };

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
      const selection = selectionSchema.parse(await task.prepare({ signal: controller.signal }));
      controller.signal.throwIfAborted();
      replace({ id: queued.id, patch: { status: 'downloading', selection } });
      await download({ selection, signal: controller.signal, onProgress: ({ progress }) => {
        if (!controller.signal.aborted) replace({ id: queued.id, patch: { progress } });
      } });
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
  function enqueue({ key, repository, source, prepare }: { key: string, repository: string, source: DownloadJob['source'], prepare: PrepareDownload }): { id: number, done: Promise<DownloadJob> } {
    const existing = jobs.value.find(job => job.key === key && jobIsBusy({ job }));
    if (existing) return { id: existing.id, done: tasks.get(existing.id)!.done };
    const id = ++sequence;
    const deferred = Promise.withResolvers<DownloadJob>();
    tasks.set(id, { prepare, done: deferred.promise, finish: ({ job }) => deferred.resolve(job) });
    // Keep only the most recent terminal job for a key; no unbounded retry log.
    jobs.value = [...jobs.value.filter(job => job.key !== key), { id, key, repository, source, status: 'queued', selection: undefined, progress: undefined, error: undefined }];
    // Queue the entire intent before discovery. Rapid clicks do not fan out
    // into metadata requests, and cancelled waiting jobs never touch storage.
    void Promise.resolve().then(drain);
    return { id, done: deferred.promise };
  }
  function cancel({ id }: { id: number }): void {
    const job = jobs.value.find(job => job.id === id);
    if (!job) return;
    switch (job.status) {
    case 'queued': {
      tasks.get(id)?.finish({ job: { ...job, status: 'cancelled' } });
      tasks.delete(id); jobs.value = jobs.value.filter(entry => entry.id !== id); return;
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
    jobs.value = jobs.value.filter(entry => entry.id !== id);
  }
  return { jobs: shallowReadonly(jobs), changed: shallowReadonly(changed), enqueue, cancel, position, forget };
}

let queue: ReturnType<typeof createDownloadQueue> | undefined;
export function getDownloadQueue(): ReturnType<typeof createDownloadQueue> {
  queue ??= createDownloadQueue({ download: async ({ selection, signal, onProgress }) => {
    signal.throwIfAborted();
    // Two explicitly queued entry points may target the same installed file set.
    // Local availability follows the same validated-file contract as the UI;
    // it is not a claim about remote revision/content equality.
    if (await installedSelection({ selection })) {
      signal.throwIfAborted(); return;
    }
    signal.throwIfAborted();
    await downloadRepository({ selection, signal, onProgress });
  } });
  return queue;
}
export const TEST_ONLY = {
  reset: () => {
    queue = undefined;
  },
};
