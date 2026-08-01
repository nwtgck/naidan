import { z } from 'zod';
import * as Comlink from 'comlink';

import { FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME } from '@/constants';
import { createNaidanSysfsRemoteReaderForMounts } from '@/features/wesh/naidan-sysfs/storage-reader';
import { createWeshStorageDirectoryRemoteForMounts } from '@/features/wesh/storage-directory/remote';
import {
  mapRemoteWeshWorkerExecutionEventToClientEvent,
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
import { registerWeshWorkerClient } from './client-registry';
import { createWeshWorkerExecutionTracker } from './execution-tracker';

const WESH_WORKER_GRACEFUL_DISPOSE_TIMEOUT_MS = 1000;

type HostedWeshWorkerRuntime = {
  readonly worker: Worker;
  readonly remote: Comlink.Remote<IWeshWorker>;
  readonly storageDirectoryRemote: ReturnType<typeof createWeshStorageDirectoryRemoteForMounts>;
};

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
    mounts: await mapWeshMountsToWorkerMounts({
      mounts,
      storageDirectoryExecution: 'worker_local',
    }),
    user,
    initialEnv,
    initialCwd,
  });

  const liveRuntimes = new Set<HostedWeshWorkerRuntime>();
  const runtimeDestructionPromises = new WeakMap<HostedWeshWorkerRuntime, Promise<void>>();

  const destroyRuntime = ({ runtime }: {
    runtime: HostedWeshWorkerRuntime;
  }): Promise<void> => {
    const existing = runtimeDestructionPromises.get(runtime);
    if (existing !== undefined) {
      return existing;
    }
    const destruction = (async () => {
      liveRuntimes.delete(runtime);
      // Termination is the hard lifecycle boundary. In particular, it releases
      // Worker-owned HizoFS Web Locks even when a cancelled execution never
      // settles or the graceful dispose RPC cannot run.
      const errors: unknown[] = [];
      try {
        runtime.remote[Comlink.releaseProxy]();
      } catch (error) {
        errors.push(error);
      }
      try {
        runtime.worker.terminate();
      } catch (error) {
        errors.push(error);
      }
      try {
        await runtime.storageDirectoryRemote?.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Failed to destroy Wesh Worker runtime');
      }
    })();
    runtimeDestructionPromises.set(runtime, destruction);
    return destruction;
  };

  const gracefullyDisposeRuntime = async ({ runtime }: {
    runtime: HostedWeshWorkerRuntime;
  }): Promise<'completed' | 'timed_out'> => {
    const completion = Promise.resolve()
      .then(async () => {
        await runtime.remote.dispose();
        return { status: 'completed' as const };
      })
      .catch(error => ({ status: 'failed' as const, error }));
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ readonly status: 'timed_out' }>(resolve => {
      timeoutId = setTimeout(
        () => resolve({ status: 'timed_out' }),
        WESH_WORKER_GRACEFUL_DISPOSE_TIMEOUT_MS,
      );
    });
    const outcome = await Promise.race([completion, timeout]).finally(() => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    });
    switch (outcome.status) {
    case 'completed':
      return 'completed';
    case 'timed_out':
      return 'timed_out';
    case 'failed':
      throw outcome.error;
    default: {
      const _ex: never = outcome;
      throw new Error(`Unhandled Wesh Worker graceful disposal result: ${String(_ex)}`);
    }
    }
  };

  const createRuntime = async () => {
    const storageDirectoryRemote = createWeshStorageDirectoryRemoteForMounts({
      mounts,
      storageDirectoryExecution: 'worker_local',
    });
    const worker = new Worker(
      new URL('./entry.ts', import.meta.url),
      {
        type: 'module',
        name: FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME,
      },
    );
    const remote = Comlink.wrap<IWeshWorker>(worker);
    const runtime: HostedWeshWorkerRuntime = { worker, remote, storageDirectoryRemote };
    try {
      // Keep the proxied reader as a separate top-level argument.
      // Putting it inside the init request object can fail structured clone in browsers.
      await remote.init(
        initRequest,
        naidanSysfsRemoteReader
          ? Comlink.proxy(naidanSysfsRemoteReader)
          : undefined,
        storageDirectoryRemote
          ? Comlink.proxy(storageDirectoryRemote)
          : undefined,
      );
      liveRuntimes.add(runtime);
      return runtime;
    } catch (initializationError: unknown) {
      try {
        await destroyRuntime({ runtime });
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [initializationError, cleanupError],
          'Wesh Worker initialization failed and its runtime could not be destroyed',
        );
      }
      throw initializationError;
    }
  };

  let runtime = await createRuntime();
  const executionTracker = createWeshWorkerExecutionTracker<HostedWeshWorkerRuntime>({
    getRemote: ({ runtime: executionRuntime }) => executionRuntime.remote,
  });
  const runtimeReplacementPromises = new WeakMap<HostedWeshWorkerRuntime, Promise<void>>();
  const pendingRuntimeReplacements = new Set<Promise<void>>();
  let disposeStarted = false;

  const replaceCancelledRuntime = ({ activeRuntime }: {
    readonly activeRuntime: HostedWeshWorkerRuntime;
  }): Promise<void> => {
    const existing = runtimeReplacementPromises.get(activeRuntime);
    if (existing !== undefined) {
      return existing;
    }
    const replacement = (async () => {
      executionTracker.forceCompleteRuntime({ runtime: activeRuntime });
      try {
        if (runtime === activeRuntime && !disposeStarted) {
          const replacementRuntime = await createRuntime();
          if (disposeStarted) {
            await destroyRuntime({ runtime: replacementRuntime });
          } else {
            runtime = replacementRuntime;
          }
        }
      } catch (replacementError: unknown) {
        try {
          await destroyRuntime({ runtime: activeRuntime });
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [replacementError, cleanupError],
            'Wesh Worker replacement failed and the cancelled runtime could not be destroyed',
          );
        }
        throw replacementError;
      }
      await destroyRuntime({ runtime: activeRuntime });
    })();
    runtimeReplacementPromises.set(activeRuntime, replacement);
    pendingRuntimeReplacements.add(replacement);
    void replacement.then(
      () => pendingRuntimeReplacements.delete(replacement),
      () => pendingRuntimeReplacements.delete(replacement),
    );
    return replacement;
  };

  return registerWeshWorkerClient({ client: {
    async startExecution({ request, onEvent }: {
      request: WeshWorkerExecuteRequest,
      onEvent?: WeshWorkerExecutionEventCallback,
    }) {
      const executionRuntime = runtime;
      const response = await executionRuntime.remote.startExecution(
        request,
        onEvent ? Comlink.proxy(async (event: WeshWorkerRemoteExecutionEvent) => {
          await onEvent({ event: mapRemoteWeshWorkerExecutionEventToClientEvent({ event }) });
        }) : undefined,
      );
      const validated = weshWorkerStartExecutionResponseSchema.parse(response);
      return weshWorkerStartExecutionResponseSchema.parse({
        executionId: executionTracker.registerExecution({
          runtime: executionRuntime,
          remoteExecutionId: validated.executionId,
        }),
      });
    },
    async awaitExecution({ request }) {
      return executionTracker.awaitExecution({ executionId: request.executionId });
    },
    async interruptExecution({ request }) {
      return executionTracker.interruptExecution({ executionId: request.executionId });
    },
    async cancelExecution({ request }) {
      const activeRuntime = executionTracker.getRuntime({ executionId: request.executionId });
      // Do not await the interrupt RPC before starting the hard-cancel timer.
      // A synchronously wedged Worker cannot answer Comlink at all.
      void executionTracker.interruptExecution({
        executionId: request.executionId,
      }).catch(() => false);

      const completionSettled = executionTracker.awaitExecution({
        executionId: request.executionId,
      }).then(() => true).catch(() => true);
      const stopped = await Promise.race([
        completionSettled,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150)),
      ]);

      if (stopped) {
        return true;
      }

      // A cancelled Worker may never settle and now owns HizoFS maintenance
      // leases. Termination is therefore part of cancellation, not deferred
      // cleanup after awaitExecution eventually resolves.
      await replaceCancelledRuntime({ activeRuntime });
      return true;
    },
    async disposeExecution({ request }) {
      await executionTracker.disposeExecution({ executionId: request.executionId });
    },
    async execute({ request }: { request: WeshWorkerExecuteRequest }) {
      const executionRuntime = runtime;
      const response = weshWorkerStartExecutionResponseSchema.parse(
        await executionRuntime.remote.startExecution(request, undefined),
      );
      const executionId = executionTracker.registerExecution({
        runtime: executionRuntime,
        remoteExecutionId: response.executionId,
      });
      try {
        return await executionTracker.awaitExecution({ executionId });
      } finally {
        await executionTracker.disposeExecution({ executionId });
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
    async dispose() {
      disposeStarted = true;
      executionTracker.forceCompleteAll();
      const errors: unknown[] = [];
      const replacementResults = await Promise.allSettled([...pendingRuntimeReplacements]);
      for (const result of replacementResults) {
        switch (result.status) {
        case 'fulfilled':
          break;
        case 'rejected':
          errors.push(result.reason);
          break;
        default: {
          const _ex: never = result;
          throw new Error(`Unhandled Wesh Worker replacement result: ${String(_ex)}`);
        }
        }
      }
      const activeRuntime = liveRuntimes.has(runtime) ? runtime : undefined;
      const retiredRuntimes = [...liveRuntimes].filter(candidate => candidate !== activeRuntime);
      const retiredResults = await Promise.allSettled(
        retiredRuntimes.map(async retiredRuntime => {
          await destroyRuntime({ runtime: retiredRuntime });
        }),
      );
      for (const result of retiredResults) {
        switch (result.status) {
        case 'fulfilled':
          break;
        case 'rejected':
          errors.push(result.reason);
          break;
        default: {
          const _ex: never = result;
          throw new Error(`Unhandled Wesh Worker runtime disposal result: ${String(_ex)}`);
        }
        }
      }
      if (activeRuntime !== undefined) {
        try {
          const disposal = await gracefullyDisposeRuntime({ runtime: activeRuntime });
          switch (disposal) {
          case 'completed':
            break;
          case 'timed_out':
            console.warn('Wesh Worker did not dispose in time and was terminated');
            break;
          default: {
            const _ex: never = disposal;
            throw new Error(`Unhandled Wesh Worker disposal result: ${String(_ex)}`);
          }
          }
        } catch (error) {
          errors.push(error);
        }
        try {
          await destroyRuntime({ runtime: activeRuntime });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Failed to dispose all Wesh Worker runtimes');
      }
    },
  } });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
