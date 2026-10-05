import { releaseWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';

/** A JS-only query worker; no inference runtime. Dispose rejects readers at once
 * and retires a worker even when its asynchronous standalone startup completes
 * after the owning page has gone away. Failed workers can be explicitly retried. */
export function createLazyImageQuerySession<Api extends object>({ createWorker, createRemote }: { createWorker(): Promise<Worker>, createRemote({ worker }: { worker: Worker }): WorkerRemote<Api> }) {
  type State = { worker: Worker, remote: WorkerRemote<Api>, onFailure: EventListener };
  let disposed = false, state: State | undefined, opening: Promise<State> | undefined;
  const pending = new Set<PromiseWithResolvers<never>['reject']>();
  function retire({ cause }: { cause: Error }): void {
    for (const reject of pending) reject(cause);
    pending.clear();
    if (!state) return;
    const target = state; state = undefined;
    target.worker.removeEventListener('error', target.onFailure);
    target.worker.removeEventListener('messageerror', target.onFailure);
    try {
      Promise.resolve(releaseWorkerRemote({ remote: target.remote })).catch(() => {});
    } catch { /* Failed workers cannot acknowledge release. */ }
    target.worker.terminate();
  }
  function acquire(): Promise<State> {
    if (disposed) return Promise.reject(new DOMException('Image query client disposed', 'AbortError'));
    if (state) return Promise.resolve(state);
    if (opening) return opening;
    const operation = (async () => {
      const worker = await createWorker();
      if (disposed) {
        worker.terminate(); throw new DOMException('Image query client disposed', 'AbortError');
      }
      try {
        const target: State = { worker, remote: createRemote({ worker }), onFailure: () => {
          if (state === target) retire({ cause: new Error('Image query Worker communication failed') });
        } };
        worker.addEventListener('error', target.onFailure); worker.addEventListener('messageerror', target.onFailure);
        state = target; return target;
      } catch (error) {
        worker.terminate(); throw error;
      }
    })();
    opening = operation;
    const clear = () => {
      if (opening === operation) opening = undefined;
    };
    void operation.then(clear, clear); return operation;
  }
  return {
    async invoke<T>({ run }: { run({ remote }: { remote: WorkerRemote<Api> }): Promise<T> }): Promise<T> {
      if (disposed) throw new DOMException('Image query client disposed', 'AbortError');
      const stopped = Promise.withResolvers<never>(); pending.add(stopped.reject);
      try {
        return await Promise.race([(async () => {
          const target = await acquire();
          if (disposed || state !== target) throw new DOMException('Image query was stopped', 'AbortError');
          return run({ remote: target.remote });
        })(), stopped.promise]);
      } finally {
        pending.delete(stopped.reject);
      }
    },
    async dispose(): Promise<void> {
      disposed = true; retire({ cause: new DOMException('Image query client disposed', 'AbortError') });
    },
  };
}
export const TEST_ONLY = {
};
