import { z } from 'zod';
import type { WorkerServerApi } from '@/utils/worker-transport';
import { workerTransfer } from '@/utils/worker-transport';
import { createFileSystemDirectoryHandleReferenceResolver } from '@/utils/file-system-handle-transport';
import { createRemoteDirectoryHandle, remoteDirectoryEntrySchema } from '@/utils/remote-directory-handle';
import { getEffectiveWeshMounts } from '@/features/wesh/mount-policy';

import { Wesh } from '@/features/wesh';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { NaidanSysfsProvider } from '@/features/wesh/naidan-sysfs/provider';
import {
  createOpfsNaidanSysfsStorageReader,
  createRemoteNaidanSysfsStorageReader,
} from '@/features/wesh/naidan-sysfs/worker-storage-reader';
import { ReadonlyDirectoryHandle } from '@/features/wesh/readonly-directory-handle';
import { WeshBrokenPipeError, type WeshFileHandle } from '@/features/wesh/types';
import { createTestReadHandleFromText } from '@/features/wesh/utils/test-stream';
import {
  weshWorkerExecuteRequestSchema,
  weshWorkerExecutionSummarySchema,
  weshWorkerInitRequestSchema,
  weshWorkerShellStateSchema,
  weshWorkerCommandEntrySchema,
  weshWorkerListDirectoryRequestSchema,
  weshWorkerPreloadCommandResponseSchema,
  weshWorkerDirectoryEntrySchema,
  type IWeshWorker,
  type WeshWorkerRemoteExecutionEvent,
} from './types';

const FORWARDING_BUFFER_LIMIT_BYTES = 32 * 1024;
const FORWARDING_BUFFER_DELAY_MS = 10;

function createForwardingHandle({
  stream,
  onEvent,
}: {
  stream: 'stdout' | 'stderr',
  onEvent: ({ event }: { event: WeshWorkerRemoteExecutionEvent }) => Promise<void>,
}) {
  let buffered: Uint8Array<ArrayBuffer> | undefined;
  let bufferedBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> | undefined;
  let flushRequested = false;
  let flushFailure: { error: unknown } | undefined;
  let accepting = true;
  let writeTail = Promise.resolve();
  let finishing: Promise<void> | undefined;
  let references = 0;

  const clearFlushTimer = (): void => {
    if (flushTimer === undefined) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  const throwStoredFlushFailure = (): void => {
    if (flushFailure !== undefined) {
      throw flushFailure.error;
    }
  };

  const requestFlush = (): void => {
    clearFlushTimer();
    if (buffered === undefined) {
      return;
    }
    if (sending !== undefined) {
      // Keep collecting into the next batch while the current callback is pending.
      flushRequested = true;
      return;
    }

    const buffer = bufferedBytes === buffered.byteLength ? buffered.buffer : buffered.slice(0, bufferedBytes).buffer;
    buffered = undefined;
    bufferedBytes = 0;
    flushRequested = false;
    sending = Promise.resolve().then(() => onEvent({
      event: workerTransfer({ value: { type: stream, buffer }, transferables: [buffer] }),
    }));
    void sending.then(
      () => {
        sending = undefined;
        if (flushRequested) {
          requestFlush();
        }
      },
      error => {
        sending = undefined;
        flushFailure = { error };
        clearFlushTimer();
        buffered = undefined;
        bufferedBytes = 0;
      },
    );
  };

  const flush = async (): Promise<void> => {
    while (true) {
      throwStoredFlushFailure();
      requestFlush();
      if (sending === undefined) {
        return;
      }
      await sending;
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== undefined || flushRequested) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      requestFlush();
    }, FORWARDING_BUFFER_DELAY_MS);
  };

  const admitWrite = ({ bytes }: { bytes: Uint8Array }): Promise<void> => {
    // Waiting writers keep their original bytes. Only this writer copies, a frame at a time.
    const accepted = writeTail.then(async () => {
      let offset = 0;
      while (offset < bytes.byteLength) {
        throwStoredFlushFailure();
        const staging = buffered ??= new Uint8Array(FORWARDING_BUFFER_LIMIT_BYTES);
        const length = Math.min(staging.byteLength - bufferedBytes, bytes.byteLength - offset);
        staging.set(bytes.subarray(offset, offset + length), bufferedBytes);
        bufferedBytes += length;
        offset += length;
        if (bufferedBytes === staging.byteLength) {
          await flush();
        } else {
          scheduleFlush();
        }
      }
    });
    writeTail = accepted;
    return accepted;
  };

  const finish = (): Promise<void> => {
    if (finishing === undefined) {
      // A surviving child may hold a copy of this descriptor after the input ends.
      accepting = false;
      finishing = writeTail.then(flush);
    }
    return finishing;
  };

  const createHandle = ({ discardAfterFinish }: { discardAfterFinish: boolean }): WeshFileHandle => {
    references += 1;
    let closed = false;
    const handle: WeshFileHandle = {
      async read() {
        throw new Error('Handle is write-only (createWeshWriteFileHandle)');
      },
      async write({ buffer, offset, length }) {
        if (closed || (!accepting && !discardAfterFinish)) {
          return { bytesWritten: 0 };
        }
        const start = offset ?? 0;
        const bytes = buffer.subarray(start, start + (length ?? buffer.length - start));
        if (accepting) {
          await admitWrite({ bytes });
        }
        return { bytesWritten: bytes.byteLength };
      },
      async writeOwned({ chunk }) {
        if (closed) {
          return;
        }
        if (!accepting && !discardAfterFinish) {
          throw new WeshBrokenPipeError();
        }
        if (accepting) {
          await admitWrite({ bytes: chunk.bytes });
        }
      },
      async close() {
        if (!closed) {
          closed = true;
          references -= 1;
          if (references === 0) {
            await finish();
          }
        }
      },
      async stat() {
        return { size: 0, mode: 0o644, type: 'fifo', mtime: Date.now(), ino: 0, uid: 0, gid: 0 };
      },
      async truncate() {
        throw new Error('Cannot truncate WeshWriteFileHandle');
      },
      async ioctl() {
        return { ret: 0 };
      },
      cloneReference() {
        // A process that retains this output description may outlive the input.
        return closed ? handle : createHandle({ discardAfterFinish: accepting || discardAfterFinish });
      },
      getCloseSemantics: () => 'hard',
    };
    return handle;
  };

  return { handle: createHandle({ discardAfterFinish: false }), finish };
}

export function createWeshWorker(): WorkerServerApi<IWeshWorker> {
  let wesh: Wesh | undefined;
  type ActiveExecution = { phase: 'starting' | 'running', controller: AbortController };
  let execution: ActiveExecution | undefined;

  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
    async init(requestOrOptions, naidanSysfsRemoteReader, managedVolumeRemoteAccess) {
      const normalizedRequest = (() => {
        if (
          typeof requestOrOptions === 'object'
          && requestOrOptions !== null
          && 'request' in requestOrOptions
        ) {
          return requestOrOptions.request;
        }
        return requestOrOptions;
      })();
      const validated = weshWorkerInitRequestSchema.parse(normalizedRequest);
      const directoryHandleResolver = createFileSystemDirectoryHandleReferenceResolver();
      const rootHandle = validated.rootHandle === 'readonly'
        ? new ReadonlyDirectoryHandle()
        : await directoryHandleResolver.resolve({ reference: validated.rootHandle });

      wesh = new Wesh({
        rootHandle,
        user: validated.user,
        initialEnv: validated.initialEnv,
        initialCwd: validated.initialCwd,
      });

      for (const mount of getEffectiveWeshMounts({ mounts: validated.mounts })) {
        switch (mount.type) {
        case 'directory':
          await wesh.vfs.mount({
            path: mount.path,
            handle: await directoryHandleResolver.resolve({ reference: mount.handle }),
            readOnly: mount.readOnly,
          });
          break;
        case 'managed_directory': {
          if (managedVolumeRemoteAccess === undefined) {
            throw new Error('Managed volume access is required for this directory');
          }
          const remoteAccess = managedVolumeRemoteAccess;
          const root = remoteDirectoryEntrySchema.parse(await remoteAccess.getRoot({ path: mount.path }));
          await wesh.vfs.mount({
            path: mount.path,
            handle: createRemoteDirectoryHandle({
              root,
              access: { request: ({ request }) => remoteAccess.request({ path: mount.path, request }) },
            }),
            readOnly: mount.readOnly,
          });
          break;
        }
        case 'naidan_sysfs': {
          const reader = await (() => {
            switch (mount.storageType) {
            case 'opfs':
              return createOpfsNaidanSysfsStorageReader();
            case 'local':
            case 'memory':
              if (naidanSysfsRemoteReader === undefined) {
                throw new Error(`Naidan sysfs remote reader is required for ${mount.storageType} storage`);
              }
              return createRemoteNaidanSysfsStorageReader({
                remoteReader: naidanSysfsRemoteReader,
              });
            default: {
              const _ex: never = mount.storageType;
              throw new Error(`Unsupported naidan sysfs storage type: ${String(_ex)}`);
            }
            }
          })();
          wesh.vfs.mountVirtual({
            path: mount.path,
            readOnly: mount.readOnly,
            provider: new NaidanSysfsProvider({
              reader,
              visibility: mount.visibility,
              binaryObjectAccess: mount.binaryObjectAccess,
              currentChatId: mount.currentChatId,
              currentChatGroupId: mount.currentChatGroupId,
            }),
          });
          break;
        }
        default: {
          const _ex: never = mount;
          throw new Error(`Unhandled Wesh worker mount type: ${String(_ex)}`);
        }
        }
      }
    },

    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
    async execute(request, onEvent) {
      const shell = wesh;
      if (!shell) {
        throw new Error('Wesh worker is not initialized');
      }

      if (execution !== undefined) {
        throw new Error('Wesh already has a foreground execution');
      }
      const validated = weshWorkerExecuteRequestSchema.parse(request);
      const emit = async ({ event }: { event: WeshWorkerRemoteExecutionEvent }) => {
        await onEvent?.(event);
      };
      const stdoutCapture = createForwardingHandle({
        stream: 'stdout',
        onEvent: emit,
      });
      const stderrCapture = createForwardingHandle({
        stream: 'stderr',
        onEvent: emit,
      });
      const stdin = createTestReadHandleFromText({ text: '' });
      const active: ActiveExecution = { phase: 'starting', controller: new AbortController() };
      execution = active;
      try {
        await emit({ event: { type: 'started' } });
        active.phase = 'running';
        const result = await shell.execute({
          source: createTextShellSource({ text: validated.script }),
          stdin,
          stdout: stdoutCapture.handle,
          stderr: stderrCapture.handle,
          signal: active.controller.signal,
        });
        await Promise.all([
          stdoutCapture.finish(),
          stderrCapture.finish(),
        ]);
        const shellState = validated.includeShellState === true ? shell.getShellState() : undefined;
        await emit({ event: { type: 'exit', exitCode: result.exitCode } });

        return weshWorkerExecutionSummarySchema.parse({
          exitCode: result.exitCode,
          ...(shellState === undefined ? {} : { shellState }),
        });
      } catch (error: unknown) {
        const forwardingErrors: unknown[] = [];
        const flushResults = await Promise.allSettled([
          stdoutCapture.finish(),
          stderrCapture.finish(),
        ]);
        for (const result of flushResults) {
          switch (result.status) {
          case 'fulfilled':
            break;
          case 'rejected':
            forwardingErrors.push(result.reason);
            break;
          default: {
            const _exhaustive: never = result;
            throw new Error(`Unhandled promise result: ${String(_exhaustive)}`);
          }
          }
        }
        try {
          await emit({
            event: {
              type: 'error',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        } catch (eventError: unknown) {
          forwardingErrors.push(eventError);
        }
        if (forwardingErrors.length > 0) {
          throw new AggregateError(
            [error, ...forwardingErrors],
            'Wesh execution failed while forwarding worker events',
          );
        }
        throw error;
      } finally {
        await Promise.allSettled([
          stdoutCapture.handle.close(),
          stderrCapture.handle.close(),
          stdin.close(),
        ]);
        execution = undefined;
      }
    },

    async getShellState() {
      if (!wesh) {
        throw new Error('Wesh worker is not initialized');
      }
      return weshWorkerShellStateSchema.parse(wesh.getShellState());
    },

    async listCommands() {
      if (!wesh) {
        throw new Error('Wesh worker is not initialized');
      }
      return z.array(weshWorkerCommandEntrySchema).parse(wesh.listCommands());
    },

    async preloadNextCommand() {
      if (!wesh) {
        throw new Error('Wesh worker is not initialized');
      }
      if (execution !== undefined) {
        return weshWorkerPreloadCommandResponseSchema.parse({ status: 'busy' });
      }

      const { hasMore } = await wesh.preloadNextBuiltinCommand();
      return weshWorkerPreloadCommandResponseSchema.parse({
        status: hasMore ? 'advanced' : 'done',
      });
    },

    async listDirectory({ request }) {
      if (!wesh) {
        throw new Error('Wesh worker is not initialized');
      }
      const validated = weshWorkerListDirectoryRequestSchema.parse(request);
      const entries = await wesh.listDirectory({ path: validated.path });
      return z.array(weshWorkerDirectoryEntrySchema).parse(entries);
    },

    async interrupt() {
      const active = execution;
      if (active === undefined) {
        return false;
      }
      active.controller.abort();
      switch (active.phase) {
      case 'starting':
        return true;
      case 'running':
        await wesh?.interruptForeground({ foregroundSignal: active.controller.signal });
        return true;
      default: {
        const exhaustive: never = active.phase;
        throw new Error(String(exhaustive));
      }
      }
    },

    async isInterruptWaitingForFilePublication() {
      return execution?.controller.signal.aborted === true && (wesh?.vfs.hasPendingFilePublications() ?? false);
    },

    async dispose() {
      wesh = undefined;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createForwardingHandle,
};
