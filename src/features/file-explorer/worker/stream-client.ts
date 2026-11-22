import { receiveByteStream } from '@/utils/byte-stream-port';
import { createValidatedMessagePort, workerTransfer, type WorkerRemote } from '@/utils/worker-transport';
import {
  fileExplorerCreateDirectoryArchiveResponseSchema,
  fileExplorerFileViewCancelSchema,
  fileExplorerFileViewProgressSchema,
  fileExplorerInspectModelOverviewResponseSchema,
  fileExplorerInspectModelResponseSchema,
  fileExplorerPrepareFileDownloadResponseSchema,
  fileExplorerReadFileForViewResponseSchema,
  fileExplorerReadModelValueRequestSchema,
  fileExplorerReadModelValueResponseSchema,
  fileExplorerRewriteGgufResponseSchema,
  fileExplorerSaveFileForViewResponseSchema,
  type FileExplorerDirectoryArchiveJob,
  type FileExplorerFileAccess,
  type IFileExplorerWorker,
} from './types';

/** Shared hosted/standalone lifecycle: native snapshots or bounded byte streams. */
export function createFileExplorerStreamClient({ remote, sessionId, worker }: {
  remote: WorkerRemote<IFileExplorerWorker>,
  sessionId: string,
  worker: Pick<Worker, 'addEventListener' | 'removeEventListener'>,
}) {
  const interrupted = Promise.withResolvers<never>();
  void interrupted.promise.catch(() => undefined);
  let failure: Error | undefined;
  const onWorkerError = () => stop({ reason: new Error('File explorer worker stopped while downloading') });
  worker.addEventListener('error', onWorkerError);
  worker.addEventListener('messageerror', onWorkerError);
  function stop({ reason }: { reason: Error }): void {
    if (failure) {
      return;
    }
    failure = reason;
    worker.removeEventListener('error', onWorkerError);
    worker.removeEventListener('messageerror', onWorkerError);
    for (const receiver of active) {
      receiver.abort({ reason });
    }
    active.clear();
    interrupted.reject(reason);
  }
  const active = new Set<ReturnType<typeof receiveByteStream>>();
  const receive = ({ port }: { port: MessagePort }) => {
    const receiver = receiveByteStream({ port });
    active.add(receiver);
    void receiver.completed.catch(() => undefined).finally(() => active.delete(receiver));
    return receiver;
  };

  async function runFileViewOperation<TResult>({ signal, onProgress, run }: {
    signal: AbortSignal | undefined,
    onProgress: (({ writtenBytes, totalBytes }: { writtenBytes: number, totalBytes: number }) => void) | undefined,
    run: ({ port }: { port: MessagePort }) => Promise<TResult>,
  }): Promise<TResult> {
    if (failure) {
      throw failure;
    }
    signal?.throwIfAborted();
    const ports = new MessageChannel();
    function onAbort() {
      channel.send({ message: { type: 'cancel' }, transferables: [] });
    }
    const channel = createValidatedMessagePort({
      port: ports.port1,
      incomingSchema: fileExplorerFileViewProgressSchema,
      outgoingSchema: fileExplorerFileViewCancelSchema,
      onMessage({ message }) {
        onProgress?.(message);
      },
      onError: onAbort,
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // Await the worker's disposition so cancellation cannot hide a save
      // that has already closed and committed the writable stream.
      return await Promise.race([interrupted.promise, run({ port: ports.port2 })]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      channel.close();
      ports.port2.close();
    }
  }

  const fileAccess = {
    read({ path, mode, maxBytes, signal }) {
      return runFileViewOperation({
        signal,
        onProgress: undefined,
        async run({ port }) {
          const result = await remote.readFileForView(workerTransfer({
            value: { request: { sessionId, path, mode, maxBytes }, port },
            transferables: [port],
          }));
          return fileExplorerReadFileForViewResponseSchema.parse(result);
        },
      });
    },
    openSnapshot({ path, signal }) {
      return runFileViewOperation({
        signal,
        onProgress: undefined,
        async run({ port }) {
          const result = await remote.readFileForView(workerTransfer({
            value: { request: { sessionId, path, mode: 'snapshot' }, port },
            transferables: [port],
          }));
          return fileExplorerReadFileForViewResponseSchema.parse(result);
        },
      });
    },
    save({ target, blob, signal, onProgress }) {
      return runFileViewOperation({
        signal,
        onProgress,
        async run({ port }) {
          const result = await remote.saveFileForView(workerTransfer({
            value: { request: { sessionId, target, blob }, port },
            transferables: [port],
          }));
          return fileExplorerSaveFileForViewResponseSchema.parse(result);
        },
      });
    },
    inspectModelOverview({ file, signal }) {
      return runFileViewOperation({
        signal,
        onProgress: undefined,
        async run({ port }) {
          const result = await remote.inspectModelOverviewForView(workerTransfer({
            value: { request: { sessionId, file }, port },
            transferables: [port],
          }));
          return fileExplorerInspectModelOverviewResponseSchema.parse(result);
        },
      });
    },
    inspectModel({ file, signal }) {
      return runFileViewOperation({
        signal,
        onProgress: undefined,
        async run({ port }) {
          const result = await remote.inspectModelForView(workerTransfer({
            value: { request: { sessionId, file }, port },
            transferables: [port],
          }));
          return fileExplorerInspectModelResponseSchema.parse(result);
        },
      });
    },
    readModelMetadataValue({ file, entry, start, limit, signal }) {
      return runFileViewOperation({
        signal,
        onProgress: undefined,
        async run({ port }) {
          const request = fileExplorerReadModelValueRequestSchema.parse({ sessionId, file, entry, start, limit });
          const result = await remote.readModelValueForView(workerTransfer({
            value: { request, port },
            transferables: [port],
          }));
          return fileExplorerReadModelValueResponseSchema.parse(result);
        },
      });
    },
    prepareGgufMetadataRewrite({ file, changes, signal }) {
      return runFileViewOperation({
        signal,
        onProgress: undefined,
        async run({ port }) {
          const result = await remote.rewriteGgufForView(workerTransfer({
            value: { request: { sessionId, file, changes }, port },
            transferables: [port],
          }));
          return fileExplorerRewriteGgufResponseSchema.parse(result);
        },
      });
    },
  } satisfies FileExplorerFileAccess;

  return {
    fileAccess,
    async prepareFileDownload({ path }: { path: string }) {
      if (failure) {
        throw failure;
      }
      const response = await Promise.race([
        interrupted.promise, remote.prepareFileDownload({ request: { sessionId, path } }),
      ]);
      if (failure) {
        throw failure;
      }
      return fileExplorerPrepareFileDownloadResponseSchema.parse(response);
    },
    async openFileStream({ path }: { path: string }): Promise<ReadableStream<Uint8Array>> {
      if (failure) {
        throw failure;
      }
      const channel = new MessageChannel();
      const receiver = receive({ port: channel.port1 });
      try {
        void remote.streamFile(workerTransfer({
          value: { request: { sessionId, path }, port: channel.port2 },
          transferables: [channel.port2],
        })).catch(reason => receiver.abort({ reason }));
      } catch (reason) {
        receiver.abort({ reason });
        channel.port2.close();
        throw reason;
      }
      return receiver.stream;
    },
    startDirectoryArchive({ directoryPath, excludedRelativePaths }: {
      directoryPath: string,
      excludedRelativePaths: string[],
    }): FileExplorerDirectoryArchiveJob {
      if (failure) {
        throw failure;
      }
      const jobId = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `file-explorer-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const channel = new MessageChannel();
      const receiver = receive({ port: channel.port1 });
      let operation: ReturnType<typeof remote.createDirectoryArchive>;
      try {
        operation = remote.createDirectoryArchive(workerTransfer({
          value: { request: { sessionId, jobId, directoryPath, excludedRelativePaths }, port: channel.port2 },
          transferables: [channel.port2],
        }));
      } catch (reason) {
        receiver.abort({ reason });
        channel.port2.close();
        throw reason;
      }
      const result = Promise.race([interrupted.promise, operation
        .then(response => fileExplorerCreateDirectoryArchiveResponseSchema.parse(response))]).catch(reason => {
        receiver.abort({ reason });
        throw reason;
      });
      void result.catch(() => undefined);
      return {
        stream: receiver.stream,
        result,
        async cancel() {
          receiver.abort({ reason: new DOMException('Directory archive cancelled', 'AbortError') });
          if (failure) {
            return;
          }
          await Promise.race([interrupted.promise, remote.cancelDirectoryArchive({ request: { sessionId, jobId } })]);
        },
      };
    },
    disposeStreams() {
      stop({ reason: new DOMException('File explorer closed', 'AbortError') });
    },
  };
}

export const TEST_ONLY = {
};
