import { releaseWorkerRemote, wrapWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';
import type { ITransformersJsWorker } from '@/features/transformers-js/types';
import { REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_ERROR_NAME } from '@/features/transformers-js/runtime/required-downloaded-resource-operation';
import { PRODUCTION_WORKER_READY, productionWorkerStartupSchema } from './production-worker-startup';
import { verifiedRuntimeModuleBlob } from '@/features/transformers-js/runtime/production-runtime-module';
import { LOAD_DIAGNOSTIC_CHANNEL, loadDiagnosticMessageSchema, type LoadDiagnosticPacket } from './load-diagnostics';

export const PRODUCTION_WORKER_STARTUP_TIMEOUT_MS = 30_000;

export class ProductionWorkerLifecycleError extends Error {
  readonly reason: 'initialization-failed' | 'startup-timeout' | 'worker-error'
    | 'message-error' | 'disposed' | 'invalid-startup-message' | 'transport-failed' | 'resource-cleanup-failed';

  constructor({ reason, message }: { reason: ProductionWorkerLifecycleError['reason'], message: string }) {
    super(message);
    this.name = 'ProductionWorkerLifecycleError';
    this.reason = reason;
  }
}

/** Owns readiness, outstanding RPCs and termination for one Production Realm. */
export function createProductionWorkerSession({ worker, startupTimeoutMs, observeLoadDiagnostic }: {
  worker: Worker,
  startupTimeoutMs: number | undefined,
  observeLoadDiagnostic?: ({ packet }: { packet: LoadDiagnosticPacket }) => unknown,
}) {
  let remote: WorkerRemote<ITransformersJsWorker> | undefined;
  let terminalError: Error | undefined;
  let runtimeModuleLease: { requestId: string; objectUrl: string | undefined; acknowledged: boolean } | undefined;
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
      try {
        worker.terminate();
      } catch {
        // A platform termination exception must not replace the primary cause
        // or become an unowned rejection of an asynchronous startup task.
      } finally {
        // The host created this URL and can revoke it even if Worker cleanup
        // never runs. Keep it for the entire Realm, not merely the first import.
        const objectUrl = runtimeModuleLease?.objectUrl;
        if (runtimeModuleLease) runtimeModuleLease.objectUrl = undefined;
        if (objectUrl !== undefined) {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch { /* Preserve the terminal cause. */ }
        }
      }
    }
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native Worker event listener boundary.
  function onMessage(event: MessageEvent<unknown>): void {
    if (terminalError) return;
    const data = event.data;
    if (typeof data === 'object' && data !== null && 'channel' in data && data.channel === LOAD_DIAGNOSTIC_CHANNEL) {
      // Same endpoint as RPC completion: records sent before settlement are
      // retained before a caller can retire this Worker. No callback RPC await.
      try {
        const diagnostic = loadDiagnosticMessageSchema.safeParse(data);
        if (diagnostic.success && observeLoadDiagnostic !== undefined) {
          const result = observeLoadDiagnostic({ packet: diagnostic.data.packet });
          if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
        }
      } catch { /* Optional observation cannot terminate or delay model work. */ }
      return;
    }
    if (typeof data !== 'object' || data === null || !('channel' in data)
      || data.channel !== PRODUCTION_WORKER_READY.channel) return;
    const parsed = productionWorkerStartupSchema.safeParse(data);
    if (!parsed.success) {
      terminate({ error: new ProductionWorkerLifecycleError({ reason: 'invalid-startup-message', message: 'Invalid Production Worker startup message' }), releaseIdleRemote: false });
      return;
    }
    switch (parsed.data.status) {
    case 'runtime-module': {
      if (runtimeModuleLease !== undefined || remote !== undefined) {
        terminate({ error: new ProductionWorkerLifecycleError({ reason: 'invalid-startup-message', message: 'Duplicate runtime module lease request' }), releaseIdleRemote: false });
        return;
      }
      const lease = { requestId: parsed.data.requestId, objectUrl: undefined as string | undefined, acknowledged: false };
      runtimeModuleLease = lease;
      // Snapshot synchronously before hashing. A late hash completion after
      // disposal must never create an unowned URL or send an acknowledgement.
      void verifiedRuntimeModuleBlob({ bytes: parsed.data.bytes, variant: parsed.data.variant }).then(blob => {
        if (terminalError) return;
        lease.objectUrl = URL.createObjectURL(blob);
        lease.acknowledged = true;
        // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Audited startup-only acknowledgement of this session's validated bytes and owned Blob; the Worker validates its strict reply schema before model RPCs exist.
        worker.postMessage({
          channel: PRODUCTION_WORKER_READY.channel, version: PRODUCTION_WORKER_READY.version,
          status: 'runtime-module-ready', requestId: lease.requestId, objectUrl: lease.objectUrl,
        });
      }).catch(error => {
        if (!terminalError) terminate({ error: new ProductionWorkerLifecycleError({
          reason: 'initialization-failed', message: error instanceof Error ? error.message : String(error),
        }), releaseIdleRemote: false });
      });
      return;
    }
    case 'failed':
      terminate({ error: new ProductionWorkerLifecycleError({ reason: 'initialization-failed', message: `Production Worker initialization failed: ${parsed.data.message}` }), releaseIdleRemote: false });
      return;
    case 'ready':
      if (!runtimeModuleLease?.acknowledged || runtimeModuleLease.objectUrl === undefined || runtimeModuleLease.requestId !== parsed.data.requestId) {
        terminate({ error: new ProductionWorkerLifecycleError({ reason: 'invalid-startup-message', message: 'Production ready requires its verified runtime module lease' }), releaseIdleRemote: false });
        return;
      }
      if (remote) {
        terminate({ error: new ProductionWorkerLifecycleError({ reason: 'invalid-startup-message', message: 'Duplicate Production ready message' }), releaseIdleRemote: false });
        return;
      }
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
  // eslint-disable-next-line local-rules-worker-transport/no-unchecked-worker-transport -- Audited startup and optional scalar diagnostic envelopes are Zod-validated above; all model RPCs use worker-transport after readiness.
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
        function handleFailure({ error }: { error: unknown }): void {
          // Comlink preserves Error name/message, not custom prototypes. A
          // cleanup deadline means this Realm still owns unfinished work;
          // terminate it before any subsequent candidate or RPC can run.
          if (error instanceof Error && error.name === REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_ERROR_NAME) {
            const lifecycleError = new ProductionWorkerLifecycleError({
              reason: 'resource-cleanup-failed',
              message: error.message,
            });
            lifecycleError.cause = error;
            terminate({ error: lifecycleError, releaseIdleRemote: false });
          }
          pending.delete(owned);
          reject(terminalError ?? error);
        }
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
                handleFailure({ error });
              });
            } catch (error) {
              handleFailure({ error });
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
