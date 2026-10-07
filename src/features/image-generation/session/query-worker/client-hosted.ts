import { releaseWorkerRemote, wrapWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';
import { generationQueryResultSchema, generationQueryToWire, type ImageGenerationQueryClient, type ImageGenerationQueryWorker } from './types';

export function createImageGenerationQueryClient(): ImageGenerationQueryClient {
  type State = { worker: Worker, remote: WorkerRemote<ImageGenerationQueryWorker>, pending: Set<PromiseWithResolvers<never>['reject']>, failed: EventListener, closed: boolean };
  let state: State | undefined;
  let disposed = false;
  function retire({ target, cause }: { target: State, cause: Error }): void {
    if (target.closed) return;
    target.closed = true;
    target.worker.removeEventListener('error', target.failed);
    target.worker.removeEventListener('messageerror', target.failed);
    for (const reject of target.pending) reject(cause);
    target.pending.clear();
    // A failed Worker cannot acknowledge Comlink release. Never wait for it.
    try {
      Promise.resolve(releaseWorkerRemote({ remote: target.remote })).catch(() => undefined);
    } catch { /* The endpoint may already be gone. */ }
    target.worker.terminate();
    if (state === target) state = undefined;
  }
  function create(): State {
    const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'naidan-image-generation-query' });
    const remote = wrapWorkerRemote<ImageGenerationQueryWorker>({ endpoint: worker });
    const target: State = {
      worker,
      remote,
      pending: new Set(),
      closed: false,
      failed: event => {
      const message = event instanceof ErrorEvent && event.message ? event.message : 'Image Generation query Worker communication failed';
      retire({ target, cause: new Error(message) });
    },
    };
    worker.addEventListener('error', target.failed);
    worker.addEventListener('messageerror', target.failed);
    return target;
  }
  return {
    async query({ store, sessionId, query }) {
      if (disposed) throw new Error('Image Generation query client is disposed');
      const target = state ??= create();
      const stopped = Promise.withResolvers<never>();
      target.pending.add(stopped.reject);
      try {
        return generationQueryResultSchema.parse(await Promise.race([
          target.remote.query({ request: generationQueryToWire({ value: { store, sessionId, query } }) }), stopped.promise,
        ]));
      } finally {
        target.pending.delete(stopped.reject);
      }
    },
    async dispose() {
      disposed = true;
      if (state) retire({ target: state, cause: new DOMException('Image Generation query client disposed', 'AbortError') });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
