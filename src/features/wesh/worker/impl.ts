import { z } from 'zod';
import * as Comlink from 'comlink';

import { Wesh } from '@/features/wesh';
import { NaidanSysfsProvider } from '@/features/wesh/naidan-sysfs/provider';
import {
  createOpfsNaidanSysfsStorageReader,
  createRemoteNaidanSysfsStorageReader,
} from '@/features/wesh/naidan-sysfs/storage-reader';
import { ReadonlyDirectoryHandle } from '@/features/wesh/readonly-directory-handle';
import { createTestReadHandleFromText } from '@/features/wesh/utils/test-stream';
import { createWriteHandleFromStream } from '@/features/wesh/utils/stream';
import {
  weshWorkerAwaitExecutionRequestSchema,
  weshWorkerDisposeExecutionRequestSchema,
  weshWorkerExecuteRequestSchema,
  weshWorkerExecutionSummarySchema,
  weshWorkerInitRequestSchema,
  weshWorkerInterruptExecutionRequestSchema,
  weshWorkerStartExecutionResponseSchema,
  weshWorkerShellStateSchema,
  weshWorkerCommandEntrySchema,
  weshWorkerListDirectoryRequestSchema,
  weshWorkerDirectoryEntrySchema,
  type IWeshWorker,
  type WeshWorkerRemoteExecutionEvent,
  type WeshWorkerExecutionSummary,
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
  let chunks: Uint8Array[] = [];
  let bufferedBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let sendChain: Promise<void> = Promise.resolve();
  let flushFailure: { error: unknown } | undefined;

  const clearFlushTimer = (): void => {
    if (flushTimer === undefined) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  const combineBufferedChunks = (): ArrayBuffer | undefined => {
    if (bufferedBytes === 0) {
      return undefined;
    }

    if (chunks.length === 1) {
      const [chunk] = chunks;
      if (
        chunk !== undefined
        && chunk.byteOffset === 0
        && chunk.byteLength === chunk.buffer.byteLength
        && chunk.buffer instanceof ArrayBuffer
      ) {
        chunks = [];
        bufferedBytes = 0;
        return chunk.buffer;
      }
    }

    const combined = new Uint8Array(bufferedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks = [];
    bufferedBytes = 0;
    return combined.buffer;
  };

  const throwStoredFlushFailure = (): void => {
    if (flushFailure !== undefined) {
      throw flushFailure.error;
    }
  };

  const flush = async (): Promise<void> => {
    clearFlushTimer();
    throwStoredFlushFailure();
    const buffer = combineBufferedChunks();
    if (buffer !== undefined) {
      sendChain = sendChain.then(async () => {
        await onEvent({
          event: Comlink.transfer({
            type: stream,
            buffer,
          }, [buffer]),
        });
      });
    }

    try {
      await sendChain;
    } catch (error: unknown) {
      flushFailure = { error };
      throw error;
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== undefined) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush().catch((error: unknown) => {
        flushFailure = { error };
      });
    }, FORWARDING_BUFFER_DELAY_MS);
  };

  const handle = createWriteHandleFromStream({
    target: new WritableStream({
      async write(chunk) {
        throwStoredFlushFailure();
        chunks.push(chunk);
        bufferedBytes += chunk.byteLength;
        if (bufferedBytes >= FORWARDING_BUFFER_LIMIT_BYTES) {
          await flush();
          return;
        }
        scheduleFlush();
      },
      async close() {
        await flush();
      },
      async abort() {
        await flush();
      },
    }),
  });

  return {
    handle,
    flush,
  };
}

export function createWeshWorker(): IWeshWorker {
  let wesh: Wesh | undefined;
  let nextExecutionId = 1;
  const executions = new Map<string, {
    completion: Promise<WeshWorkerExecutionSummary>,
  }>();

  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks and remote interfaces require top-level arguments.
    async init(requestOrOptions, naidanSysfsRemoteReader) {
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
      const rootHandle = validated.rootHandle === 'readonly'
        ? new ReadonlyDirectoryHandle()
        : validated.rootHandle;

      wesh = new Wesh({
        rootHandle,
        user: validated.user,
        initialEnv: validated.initialEnv,
        initialCwd: validated.initialCwd,
      });

      for (const mount of validated.mounts) {
        switch (mount.type) {
        case 'directory':
          await wesh.vfs.mount({
            path: mount.path,
            handle: mount.handle,
            readOnly: mount.readOnly,
          });
          break;
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
    async startExecution(request, onEvent) {
      if (!wesh) {
        throw new Error('Wesh worker is not initialized');
      }

      const validated = weshWorkerExecuteRequestSchema.parse(request);
      const executionId = `wesh-exec-${nextExecutionId}`;
      nextExecutionId += 1;
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
      const completion = (async () => {
        try {
          await emit({ event: { type: 'started' } });
          const result = await wesh.execute({
            script: validated.script,
            stdin,
            stdout: stdoutCapture.handle,
            stderr: stderrCapture.handle,
          });
          await Promise.all([
            stdoutCapture.flush(),
            stderrCapture.flush(),
          ]);
          await emit({ event: { type: 'exit', exitCode: result.exitCode } });

          return weshWorkerExecutionSummarySchema.parse({
            exitCode: result.exitCode,
          });
        } catch (error: unknown) {
          const forwardingErrors: unknown[] = [];
          const flushResults = await Promise.allSettled([
            stdoutCapture.flush(),
            stderrCapture.flush(),
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
        }
      })();

      executions.set(executionId, { completion });
      return weshWorkerStartExecutionResponseSchema.parse({ executionId });
    },

    async awaitExecution({ request }) {
      const validated = weshWorkerAwaitExecutionRequestSchema.parse(request);
      const execution = executions.get(validated.executionId);
      if (!execution) {
        throw new Error(`Unknown wesh execution: ${validated.executionId}`);
      }
      const summary = await execution.completion;
      return weshWorkerExecutionSummarySchema.parse(summary);
    },

    async interruptExecution({ request }) {
      if (!wesh) {
        return false;
      }
      const validated = weshWorkerInterruptExecutionRequestSchema.parse(request);
      if (!executions.has(validated.executionId)) {
        return false;
      }
      return wesh.signalForegroundProcessGroup({ signal: 2 });
    },

    async disposeExecution({ request }) {
      const validated = weshWorkerDisposeExecutionRequestSchema.parse(request);
      executions.delete(validated.executionId);
    },

    async execute({ request }) {
      const { executionId } = await this.startExecution(request);
      try {
        return await this.awaitExecution({ request: { executionId } });
      } finally {
        await this.disposeExecution({ request: { executionId } });
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

    async listDirectory({ request }) {
      if (!wesh) {
        throw new Error('Wesh worker is not initialized');
      }
      const validated = weshWorkerListDirectoryRequestSchema.parse(request);
      const entries = await wesh.listDirectory({ path: validated.path });
      return z.array(weshWorkerDirectoryEntrySchema).parse(entries);
    },

    async interrupt() {
      if (!wesh) {
        return false;
      }
      return wesh.signalForegroundProcessGroup({ signal: 2 });
    },

    async dispose() {
      wesh = undefined;
    },
  };
}
