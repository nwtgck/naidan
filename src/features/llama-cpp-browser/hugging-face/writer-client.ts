import { releaseWorkerRemote, wrapWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';
import type { DownloadWriterApi } from './writer';

export type DownloadWriterClient = {
  worker: Worker,
  remote: WorkerRemote<DownloadWriterApi>,
  dispose: ({ beforeRelease }: { beforeRelease: (() => Promise<unknown>) | undefined }) => Promise<void>,
};
export async function createDownloadWriterClient({ signal: _signal }: { signal: AbortSignal }): Promise<DownloadWriterClient> {
  const worker = new Worker(new URL('./writer-entry.ts', import.meta.url), { type: 'module', name: 'llama-cpp-browser-download' });
  const remote = wrapWorkerRemote<DownloadWriterApi>({ endpoint: worker });
  return {
    worker, remote,
    async dispose({ beforeRelease }) {
      try {
        await beforeRelease?.();
      } finally {
        try {
          releaseWorkerRemote({ remote });
        } finally {
          worker.terminate();
        }
      }
    },
  };
}
export const TEST_ONLY = {
};
