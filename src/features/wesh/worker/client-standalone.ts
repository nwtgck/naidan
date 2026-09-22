import { createWorkerBlobReadHost } from '@/utils/worker-blob-context';
import { z } from 'zod';
import { backgroundWorkCoordinator, type ForegroundWorkLease } from '@/logic/background-work-coordinator';
import { workerCapability, workerProxy } from '@/utils/worker-transport';

import { runWithFileSystemHandleCloneFallback } from '@/utils/file-system-handle-transport';
import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/wesh';
import {
  createStandaloneWorkerSession,
  disposeStandaloneWorkerSession,
  STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
  type StandaloneWorkerSession,
} from '@/features/file-protocol-standalone/worker/standalone-worker-session';
import { createNaidanSysfsRemoteReaderForMounts } from '@/features/wesh/naidan-sysfs/storage-reader';
import {
  mapRemoteWeshWorkerExecutionEventToClientEvent,
  weshWorkerExecutionSummarySchema,
  weshWorkerStartExecutionResponseSchema,
  weshWorkerShellStateSchema,
  weshWorkerCommandEntrySchema,
  weshWorkerListDirectoryRequestSchema,
  weshWorkerPreloadCommandResponseSchema,
  weshWorkerDirectoryEntrySchema,
  type IWeshWorker,
  type WeshWorkerClient,
  type WeshWorkerExecutionEventCallback,
  type WeshWorkerExecuteRequest,
  type WeshWorkerRemoteExecutionEvent,
} from './types';
import {
  createWeshWorkerInitRequest,
  hasWeshFileSystemHandles,
  type WeshFileSystemHandleTransport,
} from './init-request';
import type { WeshMount } from '@/features/wesh/types';

export async function createFileProtocolCompatibleWeshWorkerClient({
  rootHandle,
  mounts,
  user,
  initialEnv,
  initialCwd,
}: {
  rootHandle: FileSystemDirectoryHandle | 'readonly',
  mounts: WeshMount[],
  user: string,
  initialEnv: Record<string, string>,
  initialCwd?: string | undefined,
}): Promise<WeshWorkerClient> {
  type Runtime = StandaloneWorkerSession<IWeshWorker> & { blobReadHostLifetime: AbortController };
  const naidanSysfsRemoteReader = createNaidanSysfsRemoteReaderForMounts({ mounts });
  const createRuntime = async ({ transport }: {
    transport: WeshFileSystemHandleTransport,
  }): Promise<Runtime> => {
    const initRequest = await createWeshWorkerInitRequest({
      rootHandle,
      mounts,
      user,
      initialEnv,
      initialCwd,
      transport,
    });
    const session = await createStandaloneWorkerSession<IWeshWorker>({ createWorker: createStandaloneWorker });
    const { remote } = session;
    const blobReadHostLifetime = new AbortController();
    try {
      // Keep the proxied reader as a separate top-level argument.
      // Putting it inside the init request object can fail structured clone in browsers.
      await remote.init(
        workerCapability({
          value: initRequest,
          capability: 'file-system-handle-clone',
        }),
        naidanSysfsRemoteReader
          ? workerProxy({ value: naidanSysfsRemoteReader })
          : undefined,
        workerProxy({ value: createWorkerBlobReadHost({ signal: blobReadHostLifetime.signal }) }),
      );
      return { ...session, blobReadHostLifetime };
    } catch (error) {
      blobReadHostLifetime.abort(error);
      await disposeStandaloneWorkerSession({
        session,
        beforeRelease: undefined,
        cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
      }).catch(() => undefined);
      throw error;
    }
  };

  const createCompatibleRuntime = async (): Promise<Runtime> => {
    if (!hasWeshFileSystemHandles({ rootHandle, mounts })) {
      return createRuntime({ transport: 'direct' });
    }
    return runWithFileSystemHandleCloneFallback({
      direct: () => createRuntime({ transport: 'direct' }),
      fallback: () => createRuntime({ transport: 'opfs-locator' }),
    });
  };

  const destroyRuntime = ({ runtime }: { runtime: Runtime }): Promise<void> => {
    runtime.blobReadHostLifetime.abort(new DOMException('Wesh runtime disposed', 'AbortError'));
    return disposeStandaloneWorkerSession({
      session: runtime,
      beforeRelease: () => runtime.remote.dispose(),
      cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
    });
  };

  let runtime = await createCompatibleRuntime();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let replacement: Promise<void> | undefined;
  const foregroundExecutionLeases = new Map<string, {
    runtime: typeof runtime,
    lease: ForegroundWorkLease,
  }>();
  const releaseForegroundExecutionLease = ({ executionId, executionRuntime }: {
    executionId: string,
    executionRuntime: typeof runtime,
  }): void => {
    const entry = foregroundExecutionLeases.get(executionId);
    if (entry?.runtime !== executionRuntime) {
      return;
    }
    entry.lease.dispose();
    foregroundExecutionLeases.delete(executionId);
  };
  const releaseAllForegroundExecutionLeases = (): void => {
    for (const { lease } of foregroundExecutionLeases.values()) {
      lease.dispose();
    }
    foregroundExecutionLeases.clear();
  };
  const registerBackgroundPreload = () => backgroundWorkCoordinator.register({
    runStep: async () => {
      const activeRuntime = runtime;
      let response: ReturnType<typeof weshWorkerPreloadCommandResponseSchema.parse>;
      try {
        response = weshWorkerPreloadCommandResponseSchema.parse(
          await activeRuntime.remote.preloadNextCommand(),
        );
      } catch (error: unknown) {
        if (runtime !== activeRuntime) {
          return { status: 'continue' };
        }
        throw error;
      }
      switch (response.status) {
      case 'busy':
      case 'advanced':
        return { status: 'continue' };
      case 'done':
        return { status: 'done' };
      default: {
        const _ex: never = response.status;
        throw new Error(`Unhandled Wesh preload status: ${String(_ex)}`);
      }
      }
    },
  });
  let backgroundPreloadRegistration = registerBackgroundPreload();
  const refreshBackgroundPreloadRegistration = (): void => {
    backgroundPreloadRegistration.dispose();
    backgroundPreloadRegistration = registerBackgroundPreload();
  };

  const replaceRuntime = async ({ activeRuntime }: { activeRuntime: Runtime }): Promise<void> => {
    if (disposed || runtime !== activeRuntime) return;
    replacement ??= (async () => {
      try {
        const nextRuntime = await createCompatibleRuntime();
        if (disposed || runtime !== activeRuntime) {
          await destroyRuntime({ runtime: nextRuntime });
          return;
        }
        runtime = nextRuntime;
        releaseAllForegroundExecutionLeases();
        refreshBackgroundPreloadRegistration();
      } catch (error) {
        disposed = true;
        backgroundPreloadRegistration.dispose();
        releaseAllForegroundExecutionLeases();
        throw error;
      } finally {
        // Do not retain the old host until an unresponsive execution finishes.
        await destroyRuntime({ runtime: activeRuntime }).catch(error => {
          console.error('Failed to destroy replaced Wesh worker runtime', error);
        });
      }
    })();
    const pending = replacement;
    try {
      await pending;
    } finally {
      if (replacement === pending) replacement = undefined;
    }
  };

  return {
    async startExecution({ request, onEvent }: {
      request: WeshWorkerExecuteRequest,
      onEvent?: WeshWorkerExecutionEventCallback,
    }) {
      if (disposed) throw new Error('Wesh client is disposed');
      const foregroundLease = backgroundWorkCoordinator.beginForegroundWork();
      const activeRuntime = runtime;
      try {
        const response = await activeRuntime.remote.startExecution(
          request,
          onEvent ? workerProxy({
            // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy callback signatures are remote boundaries.
            value: async (event: WeshWorkerRemoteExecutionEvent) => {
              await onEvent({ event: mapRemoteWeshWorkerExecutionEventToClientEvent({ event }) });
            },
          }) : undefined,
        );
        const validated = weshWorkerStartExecutionResponseSchema.parse(response);
        if (disposed || runtime !== activeRuntime) {
          foregroundLease.dispose();
          return validated;
        }
        foregroundExecutionLeases.set(validated.executionId, {
          runtime: activeRuntime,
          lease: foregroundLease,
        });
        return validated;
      } catch (error: unknown) {
        foregroundLease.dispose();
        throw error;
      }
    },
    async awaitExecution({ request }) {
      const activeRuntime = runtime;
      try {
        const response = await activeRuntime.remote.awaitExecution({ request });
        return weshWorkerExecutionSummarySchema.parse(response);
      } finally {
        releaseForegroundExecutionLease({
          executionId: request.executionId,
          executionRuntime: activeRuntime,
        });
      }
    },
    async interruptExecution({ request }) {
      return runtime.remote.interruptExecution({ request });
    },
    async cancelExecution({ request }) {
      const activeRuntime = runtime;
      await activeRuntime.remote.interruptExecution({ request }).catch(() => false);

      const completionSettled = activeRuntime.remote.awaitExecution({ request }).then(() => true).catch(() => true);
      const stopped = await Promise.race([
        completionSettled,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150)),
      ]);

      if (stopped) {
        releaseForegroundExecutionLease({
          executionId: request.executionId,
          executionRuntime: activeRuntime,
        });
        return true;
      }

      await replaceRuntime({ activeRuntime });
      return true;
    },
    async disposeExecution({ request }) {
      const activeRuntime = runtime;
      try {
        await activeRuntime.remote.disposeExecution({ request });
      } finally {
        releaseForegroundExecutionLease({
          executionId: request.executionId,
          executionRuntime: activeRuntime,
        });
      }
    },
    async execute({ request }: { request: WeshWorkerExecuteRequest }) {
      if (disposed) throw new Error('Wesh client is disposed');
      const foregroundLease = backgroundWorkCoordinator.beginForegroundWork();
      try {
        const response = await runtime.remote.execute({ request });
        return weshWorkerExecutionSummarySchema.parse(response);
      } finally {
        foregroundLease.dispose();
      }
    },
    async getShellState() {
      const response = await runtime.remote.getShellState();
      return weshWorkerShellStateSchema.parse(response);
    },
    async listCommands() {
      const response = await runtime.remote.listCommands();
      return z.array(weshWorkerCommandEntrySchema).parse(response);
    },
    async listDirectory({ request }) {
      const validated = weshWorkerListDirectoryRequestSchema.parse(request);
      const response = await runtime.remote.listDirectory({ request: validated });
      return z.array(weshWorkerDirectoryEntrySchema).parse(response);
    },
    async interrupt() {
      return runtime.remote.interrupt();
    },
    dispose() {
      if (disposal !== undefined) return disposal;
      disposed = true;
      backgroundPreloadRegistration.dispose();
      releaseAllForegroundExecutionLeases();
      const destruction = destroyRuntime({ runtime });
      disposal = (async () => {
        try {
          await destruction;
        } finally {
          // A replacement whose init finishes late must be destroyed, not published.
          await replacement?.catch(() => undefined);
        }
      })();
      return disposal;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
