import { releaseWorkerRemote, wrapWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';
import type { ITransformersJsWorker } from '@/features/transformers-js/types';
import { PRODUCTION_WORKER_READY, productionWorkerStartupSchema } from './production-worker-startup';

export const PRODUCTION_WORKER_STARTUP_TIMEOUT_MS = 30_000;

export class ProductionWorkerLifecycleError extends Error {
  readonly reason: 'initialization-failed' | 'startup-timeout' | 'worker-error'
    | 'message-error' | 'disposed' | 'invalid-startup-message' | 'transport-failed';

  constructor({ reason, message }: { reason: ProductionWorkerLifecycleError['reason'], message: string }) {
    super(message);
    this.name = 'ProductionWorkerLifecycleError';
    this.reason = reason;
  }
}

/** Owns readiness, outstanding RPCs and termination for one Production Realm. */
export function createProductionWorkerSession({ worker, startupTimeoutMs }: {
  worker: Worker,
  startupTimeoutMs: number | undefined,
}) {
  let remote: WorkerRemote<ITransformersJsWorker> | undefined;
  let terminalError: Error | undefined;
  const pending = new Set<{ start(): void, reject({ error }: { error: Error }): void }>();

  function terminate({ error, releaseIdleRemote }: { error: Error, releaseIdleRemote: boolean }): void {
    if (terminalError) return;
    terminalError = error;
    clearTimeout(startupTimer);
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onError);
    worker.removeEventListener('messageerror', onMessageError);
    const mayRelease = releaseIdleRemote && pending.size === 0 && remote !== undefined;
    for (const operation of pending) operation.reject({ error });
    pending.clear();
    try {
      if (mayRelease && remote) {
        // Advisory only, never await a remote release before physical termination.
        void Promise.resolve(releaseWorkerRemote({ remote })).catch(() => undefined);
      }
    } catch {
      // Preserve the primary terminal failure even if advisory release fails.
    } finally {
      worker.terminate();
    }
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native Worker event listener boundary.
  function onMessage(event: MessageEvent<unknown>): void {
    if (terminalError) return;
    const data = event.data;
    if (typeof data !== 'object' || data === null || !('channel' in data)
      || data.channel !== PRODUCTION_WORKER_READY.channel) return;
    const parsed = productionWorkerStartupSchema.safeParse(data);
    if (!parsed.success) {
      terminate({ error: new ProductionWorkerLifecycleError({ reason: 'invalid-startup-message', message: 'Invalid Production Worker startup message' }), releaseIdleRemote: false });
      return;
    }
    switch (parsed.data.status) {
    case 'failed':
      terminate({ error: new ProductionWorkerLifecycleError({ reason: 'initialization-failed', message: `Production Worker initialization failed: ${parsed.data.message}` }), releaseIdleRemote: false });
      return;
    case 'ready':
      if (remote) return;
      clearTimeout(startupTimer);
      try {
        remote = wrapWorkerRemote<ITransformersJsWorker>({ endpoint: worker });
        for (const operation of [...pending]) operation.start();
      } catch (error) {
        terminate({ error: new ProductionWorkerLifecycleError({ reason: 'transport-failed', message: error instanceof Error ? error.message : String(error) }), releaseIdleRemote: false });
      }
      return;
    default: {
      const _ex: never = parsed.data;
      throw new Error(`Unhandled Production Worker startup message: ${_ex}`);
    }
    }
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native Worker event listener boundary.
  function onError(event: ErrorEvent): void {
    terminate({ error: new ProductionWorkerLifecycleError({ reason: 'worker-error', message: event.message || 'Production Worker failed' }), releaseIdleRemote: false });
  }
  function onMessageError(): void {
    terminate({ error: new ProductionWorkerLifecycleError({ reason: 'message-error', message: 'Production Worker message deserialization failed' }), releaseIdleRemote: false });
  }

  const timeoutMs = startupTimeoutMs ?? PRODUCTION_WORKER_STARTUP_TIMEOUT_MS;
  const startupTimer = setTimeout(() => terminate({
    error: new ProductionWorkerLifecycleError({ reason: 'startup-timeout', message: `Production Worker startup timed out after ${timeoutMs}ms` }),
    releaseIdleRemote: false,
  }), timeoutMs);
  // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Audited startup-only protocol is Zod-validated above; all model RPCs use worker-transport after readiness.
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);
  worker.addEventListener('messageerror', onMessageError);

  return {
    isActive(): boolean {
      return terminalError === undefined;
    },
    run<T>({ operation }: {
      operation: ({ remote }: { remote: WorkerRemote<ITransformersJsWorker> }) => Promise<T>,
    }): Promise<T> {
      if (terminalError) return Promise.reject(terminalError);
      return new Promise<T>((resolve, reject) => {
        const owned = {
          reject({ error }: { error: Error }) {
            reject(error);
          },
          start() {
            if (terminalError || !remote) return;
            try {
              void Promise.resolve(operation({ remote })).then(value => {
                pending.delete(owned);
                if (!terminalError) resolve(value);
              }, error => {
                pending.delete(owned);
                reject(error);
              });
            } catch (error) {
              pending.delete(owned);
              reject(error);
            }
          },
        };
        pending.add(owned);
        if (remote) owned.start();
      });
    },
    dispose(): void {
      terminate({ error: new ProductionWorkerLifecycleError({ reason: 'disposed', message: 'Production Worker disposed' }), releaseIdleRemote: true });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
