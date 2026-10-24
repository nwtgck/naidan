import { releaseWorkerRemote, wrapWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';
import type { FileDownloadWorker } from './types';
export type FileDownloadSession = { worker: Worker, remote: WorkerRemote<FileDownloadWorker>, dispose(): Promise<void> };

export async function createFileDownloadSession({ signal }: { signal: AbortSignal }): Promise<FileDownloadSession> {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'naidan-file-download' });
  try {
    const remote = wrapWorkerRemote<FileDownloadWorker>({ endpoint: worker });
    return {
      worker,
      remote,
      async dispose() {
        try {
          void Promise.resolve(releaseWorkerRemote({ remote })).catch(() => undefined);
        } finally {
          worker.terminate();
        }
      },
    };
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

export const TEST_ONLY = {
};
