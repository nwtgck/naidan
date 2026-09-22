import { releaseWorkerRemote, wrapWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import type { DownloadWriterApi } from './writer';

export type DownloadWriterClient = {
  worker: Worker,
  remote: WorkerRemote<DownloadWriterApi>,
  dispose: ({ beforeRelease }: { beforeRelease: (() => Promise<unknown>) | undefined }) => Promise<void>,
};
export async function createDownloadWriterClient({ signal }: { signal: AbortSignal }): Promise<DownloadWriterClient> {
  if (signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  const worker = new Worker(new URL('./writer-entry.ts', import.meta.url), { type: 'module', name: 'llama-cpp-browser-download' });
  const remote = wrapWorkerRemote<DownloadWriterApi>({ endpoint: worker });
  let disposing: Promise<void> | undefined;
  return {
    worker, remote,
    dispose({ beforeRelease }) {
      disposing ??= (async () => {
        try {
          await beforeRelease?.();
        } finally {
          try {
            await releaseWorkerRemote({ remote });
          } finally {
            worker.terminate();
          }
        }
      })();
      return disposing;
    },
  };
}
export const TEST_ONLY = {
};
