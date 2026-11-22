import { z } from 'zod';
import { backgroundWorkCoordinator, type BackgroundWorkRegistration } from '@/logic/background-work-coordinator';
import { runWithFileSystemHandleCloneFallback } from '@/utils/file-system-handle-transport';
import { releaseWorkerRemote, workerCapability, workerProxy, type WorkerRemote } from '@/utils/worker-transport';
import { FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION } from '@/utils/worker-transport-capabilities';
import { createNaidanSysfsRemoteReaderForMounts } from '@/features/wesh/naidan-sysfs/storage-reader';
import type { WeshMount } from '@/features/wesh/types';
import { createWeshWorkerInitRequest } from './init-request';
import { createManagedVolumeRemoteAccess, observeManagedVolumeWorker } from './managed-volume-access';
import {
  mapRemoteWeshWorkerExecutionEventToClientEvent,
  weshWorkerCommandEntrySchema,
  weshWorkerDirectoryEntrySchema,
  weshWorkerExecuteRequestSchema,
  weshWorkerExecutionSummarySchema,
  weshWorkerListDirectoryRequestSchema,
  weshWorkerPreloadCommandResponseSchema,
  weshWorkerShellStateSchema,
  type IWeshWorker,
  type WeshWorkerClient,
  type WeshWorkerExecutionOutcome,
  type WeshWorkerRemoteExecutionEvent,
} from './types';

const INTERRUPT_GRACE_MS = 150;
const FILE_PUBLICATION_POLL_MS = 50;
const INTERRUPT_FILE_PUBLICATION_LIMIT_MS = 3_000;

type WeshWorkerSession = { worker: Worker, remote: WorkerRemote<IWeshWorker> };
type WeshWorkerRuntime = {
  lifetime: AbortController,
  ready: Promise<WorkerRemote<IWeshWorker>>,
  remote: WorkerRemote<IWeshWorker> | undefined,
  preload: BackgroundWorkRegistration | undefined,
};

async function untilRuntimeCloses<T>({ signal, operation }: {
  signal: AbortSignal,
  operation: () => Promise<T>,
}): Promise<T> {
  signal.throwIfAborted();
  const stopped = Promise.withResolvers<never>();
  const onStop = () => stopped.reject(signal.reason);
  signal.addEventListener('abort', onStop, { once: true });
  try {
    return await Promise.race([operation(), stopped.promise]);
  } finally {
    signal.removeEventListener('abort', onStop);
  }
}

export function createWeshWorkerClient({ rootHandle, mounts, user, initialEnv, initialCwd, onRuntimeFailure, createSession }: {
  rootHandle: FileSystemDirectoryHandle | 'readonly',
  mounts: WeshMount[],
  user: string,
  initialEnv: Record<string, string>,
  initialCwd: string | undefined,
  onRuntimeFailure?: (() => void) | undefined,
  createSession: ({ signal }: { signal: AbortSignal }) => Promise<WeshWorkerSession>,
}): WeshWorkerClient {
  const naidanSysfsRemoteReader = createNaidanSysfsRemoteReaderForMounts({ mounts });
  let runtime: WeshWorkerRuntime | undefined;
  let stopExecution: (() => void) | undefined;
  let disposed = false;

  async function initialize({ signal, onFailure }: {
    signal: AbortSignal,
    onFailure: ({ event }: { event: Event }) => void,
  }): Promise<WorkerRemote<IWeshWorker>> {
    const request = await createWeshWorkerInitRequest({ rootHandle, mounts, user, initialEnv, initialCwd, transport: 'direct' });
    const connect = async ({ request: initRequest }: { request: Parameters<IWeshWorker['init']>[0] }) => {
      signal.throwIfAborted();
      let managedVolumes: Awaited<ReturnType<typeof createManagedVolumeRemoteAccess>> | undefined;
      let session: WeshWorkerSession | undefined;
      let stopObserving: (() => void) | undefined;
      const close = () => {
        if (managedVolumes !== undefined) {
          // The call closes admission synchronously. Already admitted storage work can finish.
          void managedVolumes.dispose().catch(error => console.error('Failed to close Wesh managed volume access', error));
          managedVolumes = undefined;
        }
        stopObserving?.();
        stopObserving = undefined;
        if (session !== undefined) {
          const { worker, remote } = session;
          session = undefined;
          worker.terminate();
          try {
            void Promise.resolve(releaseWorkerRemote({ remote })).catch(() => undefined);
          } catch { /* A stopped transport may reject release. */ }
        }
      };
      signal.addEventListener('abort', close, { once: true });
      try {
        managedVolumes = await createManagedVolumeRemoteAccess({ mounts, signal });
        signal.throwIfAborted();
        session = await createSession({ signal });
        signal.throwIfAborted();
        const { worker, remote } = session;
        const managedAccess = managedVolumes.remote;
        stopObserving = observeManagedVolumeWorker({ worker, connection: managedVolumes, onFailure });
        await untilRuntimeCloses({
          signal,
          operation: () => remote.init(
            initRequest,
            naidanSysfsRemoteReader ? workerProxy({ value: naidanSysfsRemoteReader }) : undefined,
            ...(managedAccess ? [workerProxy({ value: managedAccess })] as const : []),
          ),
        });
        signal.throwIfAborted();
        return remote;
      } catch (error) {
        signal.removeEventListener('abort', close);
        close();
        throw error;
      }
    };

    return runWithFileSystemHandleCloneFallback({
      request,
      direct: connect,
      fallback: async () => {
        signal.throwIfAborted();
        return connect({
          request: await workerCapability({
            value: await createWeshWorkerInitRequest({ rootHandle, mounts, user, initialEnv, initialCwd, transport: 'opfs-locator' }),
            capability: FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION,
          }),
        });
      },
    });
  }

  function discardRuntime({ reason }: { reason: unknown }): void {
    const old = runtime;
    runtime = undefined;
    old?.preload?.dispose();
    old?.lifetime.abort(reason);
  }

  function getRuntime(): WeshWorkerRuntime {
    if (disposed) {
      throw new Error('Wesh worker client is disposed');
    }
    if (runtime !== undefined) {
      return runtime;
    }
    const lifetime = new AbortController();
    const next: WeshWorkerRuntime = {
      lifetime,
      remote: undefined,
      preload: undefined,
      ready: initialize({
        signal: lifetime.signal,
        onFailure({ event }) {
          if (runtime === next) {
            const message = typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent && event.message
              ? event.message
              : `Wesh Worker failed (${event.type})`;
            discardRuntime({ reason: new Error(message) });
            onRuntimeFailure?.();
          }
        },
      }).then(remote => {
        lifetime.signal.throwIfAborted();
        next.remote = remote;
        next.preload = backgroundWorkCoordinator.register({
          runStep: async () => {
            try {
              const { status } = weshWorkerPreloadCommandResponseSchema.parse(await untilRuntimeCloses({
                signal: lifetime.signal,
                operation: () => remote.preloadNextCommand(),
              }));
              switch (status) {
              case 'busy':
              case 'advanced':
                return { status: 'continue' };
              case 'done':
                return { status: 'done' };
              default: {
                const exhaustive: never = status;
                throw new Error(String(exhaustive));
              }
              }
            } catch (error) {
              if (lifetime.signal.aborted) {
                return { status: 'done' };
              }
              throw error;
            }
          },
        });
        return remote;
      }).catch(error => {
        if (runtime === next) {
          discardRuntime({ reason: error });
        }
        throw error;
      }),
    };
    runtime = next;
    return next;
  }

  async function observe<T>({ operation }: {
    operation: ({ remote }: { remote: WorkerRemote<IWeshWorker> }) => Promise<T>,
  }): Promise<T> {
    const current = getRuntime();
    return untilRuntimeCloses({
      signal: current.lifetime.signal,
      operation: async () => {
        const remote = await current.ready;
        current.lifetime.signal.throwIfAborted();
        return operation({ remote });
      },
    });
  }

  return {
    startExecution({ request, onEvent }) {
      if (disposed || stopExecution !== undefined) {
        throw new Error(disposed ? 'Wesh worker client is disposed' : 'Wesh already has a foreground execution');
      }
      const validated = weshWorkerExecuteRequestSchema.parse(request);
      const current = getRuntime();
      const result = Promise.withResolvers<WeshWorkerExecutionOutcome>();
      const lease = backgroundWorkCoordinator.beginForegroundWork();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let publicationPoll: ReturnType<typeof setTimeout> | undefined;
      let executionRemote: WorkerRemote<IWeshWorker> | undefined;
      let deliverEvent = onEvent;
      const isActive = () => stopExecution === stop;
      const retire = () => {
        stopExecution = undefined;
        deliverEvent = undefined;
        executionRemote = undefined;
        clearTimeout(timer);
        clearTimeout(publicationPoll);
        lease.dispose();
      };
      const stop = () => {
        if (!isActive()) {
          return;
        }
        retire();
        if (runtime === current) {
          discardRuntime({ reason: undefined });
        }
        result.resolve({ status: 'terminated' });
      };
      stopExecution = stop;

      const run = async ({ remote }: { remote: WorkerRemote<IWeshWorker> }) => {
        if (!isActive()) {
          return;
        }
        current.lifetime.signal.throwIfAborted();
        if (timer !== undefined) {
          // Startup finished after cancellation. There is no foreground process yet.
          stop();
          return;
        }
        executionRemote = remote;
        const response = await remote.execute(
          validated,
          onEvent === undefined ? undefined : workerProxy({
            // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the Comlink callback boundary.
            value: async (event: WeshWorkerRemoteExecutionEvent) => {
              if (!current.lifetime.signal.aborted) {
                await deliverEvent?.({ event: mapRemoteWeshWorkerExecutionEventToClientEvent({ event }) });
              }
            },
          }),
        );
        if (isActive()) {
          current.lifetime.signal.throwIfAborted();
          const { exitCode, shellState } = weshWorkerExecutionSummarySchema.parse(response);
          if (validated.includeShellState === true && shellState === undefined) {
            throw new Error('Shell state is missing from the execution result');
          }
          retire();
          result.resolve({ status: 'exited', exitCode, ...(validated.includeShellState === true ? { shellState } : {}) });
        }
      };
      const remote = current.remote;
      void untilRuntimeCloses({
        signal: current.lifetime.signal,
        operation: () => remote === undefined ? current.ready.then(value => run({ remote: value })) : run({ remote }),
      }).catch(error => {
        if (isActive()) {
          retire();
          result.reject(error);
        }
      });

      return {
        completion: result.promise,
        cancel() {
          if (!isActive() || timer !== undefined) {
            return;
          }
          timer = setTimeout(stop, INTERRUPT_GRACE_MS);
          const remote = executionRemote;
          if (remote !== undefined) {
            // The worker may be unable to process even the interrupt message.
            void Promise.resolve().then(() => isActive() && remote.interrupt()).catch(() => undefined);
            const deadline = performance.now() + INTERRUPT_FILE_PUBLICATION_LIMIT_MS;
            const canObserve = () => isActive() && runtime === current;
            const observePublication = async () => {
              if (!canObserve()) {
                return;
              }
              try {
                const waiting = z.boolean().parse(await remote.isInterruptWaitingForFilePublication());
                if (!canObserve()) {
                  return;
                }
                const remaining = deadline - performance.now();
                if (waiting) {
                  clearTimeout(timer);
                  timer = setTimeout(stop, Math.max(0, Math.min(INTERRUPT_GRACE_MS, remaining)));
                }
                if (remaining > FILE_PUBLICATION_POLL_MS) {
                  publicationPoll = setTimeout(observePublication, FILE_PUBLICATION_POLL_MS);
                }
              } catch {
                // A broken status RPC leaves the current force-stop deadline in place.
              }
            };
            publicationPoll = setTimeout(observePublication, FILE_PUBLICATION_POLL_MS);
          }
        },
      };
    },
    getShellState() {
      return observe({ operation: async ({ remote }) => weshWorkerShellStateSchema.parse(await remote.getShellState()) });
    },
    listCommands() {
      return observe({ operation: async ({ remote }) => z.array(weshWorkerCommandEntrySchema).parse(await remote.listCommands()) });
    },
    listDirectory({ request }) {
      const validated = weshWorkerListDirectoryRequestSchema.parse(request);
      return observe({ operation: async ({ remote }) => z.array(weshWorkerDirectoryEntrySchema).parse(await remote.listDirectory({ request: validated })) });
    },
    async dispose() {
      disposed = true;
      const stop = stopExecution;
      if (stop === undefined) {
        discardRuntime({ reason: undefined });
      } else {
        stop();
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
