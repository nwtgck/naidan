import type { DownloadFile, ManagedDownload } from '@/01-models/download';

export type DownloadExecution = {
  signal: AbortSignal,
  setFiles: ({ files }: { files: readonly DownloadFile[] }) => void,
  reportFile: ({ index, patch }: { index: number, patch: Partial<DownloadFile> }) => void,
};
type Run = ({ execution }: { execution: DownloadExecution }) => Promise<void>;
type Entry = {
  job: ManagedDownload,
  run: Run | undefined,
  onResume: (() => void) | undefined,
  attempt: ReturnType<typeof Promise.withResolvers<ManagedDownload>>,
  intent: 'run' | 'pause' | 'remove',
};

function removing({ entry }: { entry: Entry }): boolean {
  switch (entry.intent) {
  case 'remove': return true;
  case 'run': case 'pause': return false;
  default: {
    const exhaustive: never = entry.intent;
    throw new Error(String(exhaustive));
  }
  }
}

/** The only page-wide execution lane. It owns work, never a component scope.
 * A cancelled writer keeps its slot until run() finishes its own cleanup.
 * Completed history is memory-only, and completed entries release their tasks.
 */
export function createDownloadManager() {
  let sequence = 0;
  let entries: Entry[] = [];
  let running: { entry: Entry, controller: AbortController } | undefined;
  const listeners = new Set<() => void>();
  const snapshot = (): readonly ManagedDownload[] => entries.map(entry => ({ ...entry.job, destination: { ...entry.job.destination }, files: entry.job.files.map(file => ({ ...file })) }));
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch { /* A presentation subscriber cannot control file storage. */ }
    }
  };
  function update({ entry, patch }: { entry: Entry, patch: Partial<ManagedDownload> }): void {
    entry.job = { ...entry.job, ...patch };
    notify();
  }
  function schedule(): void {
    void Promise.resolve().then(drain);
  }
  async function drain(): Promise<void> {
    if (running) {
      return;
    }
    const entry = entries.find(candidate => candidate.job.status === 'queued');
    if (!entry?.run) {
      return;
    }
    const controller = new AbortController();
    const active = { entry, controller };
    const attempt = entry.attempt;
    running = active;
    entry.intent = 'run';
    update({ entry, patch: { status: 'resolving', error: undefined } });
    const execution: DownloadExecution = {
      signal: controller.signal,
      setFiles({ files }) {
        if (running !== active || controller.signal.aborted) {
          return;
        }
        update({ entry, patch: { status: 'downloading', files: files.map(file => ({ ...file })) } });
      },
      reportFile({ index, patch }) {
        if (running !== active || controller.signal.aborted) {
          return;
        }
        if (!Number.isSafeInteger(index) || !entry.job.files[index]) {
          throw new Error('Invalid download file progress index');
        }
        const file = { ...entry.job.files[index]!, ...patch };
        if (!Number.isSafeInteger(file.completed) || file.completed < 0 || (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < file.completed))) {
          throw new Error('Invalid download byte accounting');
        }
        update({ entry, patch: { status: 'downloading', files: entry.job.files.map((previous, position) => position === index ? file : previous) } });
      },
    };
    let terminal: ManagedDownload;
    try {
      controller.signal.throwIfAborted();
      await entry.run({ execution });
      // A resolved operation has committed. A coincident pause must not undo it.
      terminal = { ...entry.job, status: 'complete', error: undefined, files: entry.job.files.map(file => ({ ...file, state: 'complete', completed: file.size ?? file.completed })) };
      entry.run = undefined;
      entry.onResume = undefined;
    } catch (error) {
      terminal = {
        ...entry.job,
        status: controller.signal.aborted ? 'paused' : 'failed',
        error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : String(error),
      };
    }
    // Retire this attempt before notifications: a listener may immediately retry.
    // Never delete the new attempt or its task after that reentrant callback.
    running = undefined;
    if (removing({ entry })) {
      terminal = { ...terminal, status: 'cancelled' };
      entry.run = undefined;
      entry.onResume = undefined;
      entries = entries.filter(candidate => candidate !== entry);
    }
    entry.job = terminal;
    attempt.resolve(terminal);
    notify();
    schedule();
  }
  function enqueue({ key, title, category, destination, files, run, onResume }: {
    key: string, title: string, category: ManagedDownload['category'], destination: ManagedDownload['destination'], files: readonly DownloadFile[], run: Run, onResume?: () => void,
  }): { id: number, done: Promise<ManagedDownload> } {
    const existing = entries.find(entry => entry.job.key === key && entry.job.status !== 'complete');
    if (existing) {
      return { id: existing.job.id, done: existing.attempt.promise };
    }
    const entry: Entry = {
      job: { id: ++sequence, key, title, category, destination: { ...destination }, status: 'queued', files: files.map(file => ({ ...file })), error: undefined },
      run,
      onResume,
      attempt: Promise.withResolvers<ManagedDownload>(),
      intent: 'run',
    };
    entries = [...entries, entry];
    notify();
    schedule();
    return { id: entry.job.id, done: entry.attempt.promise };
  }
  function pause({ id }: { id: number }): void {
    const entry = entries.find(candidate => candidate.job.id === id);
    if (!entry) {
      return;
    }
    if (running?.entry === entry) {
      if (removing({ entry })) {
        return;
      }
      entry.intent = 'pause';
      const controller = running.controller;
      update({ entry, patch: { status: 'pausing' } });
      controller.abort(new DOMException('Download paused', 'AbortError'));
    } else {
      switch (entry.job.status) {
      case 'queued':
        entry.intent = 'pause';
        entry.job = { ...entry.job, status: 'paused' };
        entry.attempt.resolve(entry.job);
        notify();
        break;
      case 'resolving': case 'downloading': case 'pausing': case 'paused': case 'failed': case 'complete': case 'cancelling': case 'cancelled': break;
      default: {
        const exhaustive: never = entry.job.status;
        throw new Error(String(exhaustive));
      }
      }
    }
  }
  function resume({ id }: { id: number }): Promise<ManagedDownload> | undefined {
    const entry = entries.find(candidate => candidate.job.id === id);
    if (!entry?.run || running?.entry === entry || (entry.job.status !== 'paused' && entry.job.status !== 'failed')) {
      return undefined;
    }
    entry.attempt = Promise.withResolvers<ManagedDownload>();
    entry.intent = 'run';
    // Start permission authorization in the explicit retry gesture, not when a
    // potentially long queue eventually reaches this entry.
    try {
      entry.onResume?.();
    } catch (error) {
      entry.job = { ...entry.job, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      entry.attempt.resolve(entry.job);
      notify();
      return entry.attempt.promise;
    }
    // Queue order is independent of stable list order.
    entries = [...entries.filter(candidate => candidate !== entry), entry];
    update({ entry, patch: { status: 'queued', error: undefined } });
    schedule();
    return entry.attempt.promise;
  }
  function remove({ id }: { id: number }): Promise<ManagedDownload> | undefined {
    const entry = entries.find(candidate => candidate.job.id === id);
    if (!entry) {
      return undefined;
    }
    entry.intent = 'remove';
    const done = entry.attempt.promise;
    if (running?.entry === entry) {
      const controller = running.controller;
      update({ entry, patch: { status: 'cancelling' } });
      controller.abort(new DOMException('Download cancelled', 'AbortError'));
    } else {
      entries = entries.filter(candidate => candidate !== entry);
      entry.run = undefined;
      entry.onResume = undefined;
      entry.job = { ...entry.job, status: 'cancelled' };
      entry.attempt.resolve(entry.job);
      notify();
    }
    return done;
  }
  async function stopDirectory({ directoryId }: { directoryId: string }): Promise<void> {
    // Unlink can fail while saving settings. Quiesce writers without destroying
    // retryable intent; committed unlink listeners may then remove their entries.
    const affected = entries.filter(entry => entry.job.destination.kind === 'host' && entry.job.destination.directoryId === directoryId);
    const stopped = affected.map(entry => {
      pause({ id: entry.job.id });
      return entry.attempt.promise;
    });
    await Promise.all(stopped);
  }
  function wait({ id }: { id: number }): Promise<ManagedDownload> | undefined {
    return entries.find(entry => entry.job.id === id)?.attempt.promise;
  }
  function position({ id }: { id: number }): number | undefined {
    const index = entries.filter(entry => entry.job.status === 'queued').findIndex(entry => entry.job.id === id);
    return index < 0 ? undefined : index + 1;
  }
  function subscribe({ listener }: { listener: () => void }): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  function clearCompleted(): void {
    entries = entries.filter(entry => entry.job.status !== 'complete');
    notify();
  }
  return { snapshot, subscribe, enqueue, pause, resume, remove, stopDirectory, wait, position, clearCompleted };
}

export type DownloadManager = ReturnType<typeof createDownloadManager>;
let shared: DownloadManager | undefined;

export function getDownloadManager(): DownloadManager {
  shared ??= createDownloadManager();
  return shared;
}

export const TEST_ONLY = {
  reset() {
    shared = undefined;
  },
};
