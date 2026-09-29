import { receiveByteStream } from '@/utils/byte-stream-port';
import { workerTransfer, type WorkerRemote } from '@/utils/worker-transport';
import {
  fileExplorerCreateDirectoryArchiveResponseSchema,
  type FileExplorerDirectoryArchiveJob,
  type IFileExplorerWorker,
} from './types';

/** Shared by hosted and standalone: no Blob and no browser-specific transport. */
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
    if (failure) return;
    failure = reason;
    worker.removeEventListener('error', onWorkerError);
    worker.removeEventListener('messageerror', onWorkerError);
    for (const receiver of active) receiver.abort({ reason });
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
  return {
    async openFileStream({ path }: { path: string }): Promise<ReadableStream<Uint8Array>> {
      if (failure) throw failure;
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
      if (failure) throw failure;
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
          if (failure) return;
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
