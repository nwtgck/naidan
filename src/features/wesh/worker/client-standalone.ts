import { z } from 'zod';
import * as Comlink from 'comlink';

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
  mapWeshMountsToWorkerMounts,
  weshWorkerStartExecutionResponseSchema,
  weshWorkerInitRequestSchema,
  weshWorkerShellStateSchema,
  weshWorkerCommandEntrySchema,
  weshWorkerListDirectoryRequestSchema,
  weshWorkerDirectoryEntrySchema,
  type IWeshWorker,
  type WeshWorkerClient,
  type WeshWorkerExecutionEventCallback,
  type WeshWorkerExecuteRequest,
  type WeshWorkerRemoteExecutionEvent,
} from './types';
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
  const naidanSysfsRemoteReader = createNaidanSysfsRemoteReaderForMounts({ mounts });
  const initRequest = weshWorkerInitRequestSchema.parse({
    rootHandle,
    mounts: mapWeshMountsToWorkerMounts({ mounts }),
    user,
    initialEnv,
    initialCwd,
  });

  const createRuntime = async (): Promise<StandaloneWorkerSession<IWeshWorker>> => {
    const session = await createStandaloneWorkerSession<IWeshWorker>({ createWorker: createStandaloneWorker });
    const { remote } = session;
    try {
      // Keep the proxied reader as a separate top-level argument.
      // Putting it inside the init request object can fail structured clone in browsers.
      await remote.init(
        initRequest,
        naidanSysfsRemoteReader
          ? Comlink.proxy(naidanSysfsRemoteReader)
          : undefined,
      );
      return session;
    } catch (error) {
      await disposeStandaloneWorkerSession({
        session,
        beforeRelease: undefined,
        cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
      }).catch(() => undefined);
      throw error;
    }
  };

  const destroyRuntime = async ({ runtime }: {
    runtime: StandaloneWorkerSession<IWeshWorker>,
  }) => {
    await disposeStandaloneWorkerSession({
      session: runtime,
      beforeRelease: undefined,
      cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
    });
  };

  let runtime = await createRuntime();

  return {
    async startExecution({ request, onEvent }: {
      request: WeshWorkerExecuteRequest,
      onEvent?: WeshWorkerExecutionEventCallback,
    }) {
      const response = await runtime.remote.startExecution(
        request,
        onEvent ? Comlink.proxy(async (event: WeshWorkerRemoteExecutionEvent) => {
          await onEvent({ event: mapRemoteWeshWorkerExecutionEventToClientEvent({ event }) });
        }) : undefined,
      );
      return weshWorkerStartExecutionResponseSchema.parse(response);
    },
    async awaitExecution({ request }) {
      const response = await runtime.remote.awaitExecution({ request });
      return weshWorkerExecutionSummarySchema.parse(response);
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
        return true;
      }

      try {
        runtime = await createRuntime();
      } catch (error) {
        await destroyRuntime({ runtime: activeRuntime }).catch(cleanupError => {
          console.error('Failed to destroy cancelled standalone Wesh worker runtime after replacement failure', cleanupError);
        });
        throw error;
      }
      void destroyRuntime({ runtime: activeRuntime }).catch(error => {
        console.error('Failed to destroy cancelled standalone Wesh worker runtime', error);
      });
      return true;
    },
    async disposeExecution({ request }) {
      await runtime.remote.disposeExecution({ request });
    },
    async execute({ request }: { request: WeshWorkerExecuteRequest }) {
      const response = await runtime.remote.execute({ request });
      return weshWorkerExecutionSummarySchema.parse(response);
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
    async dispose() {
      const activeRuntime = runtime;
      await disposeStandaloneWorkerSession({
        session: activeRuntime,
        beforeRelease: () => activeRuntime.remote.dispose(),
        cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
      });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
