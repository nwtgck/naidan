import { workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
import { disposeDedicatedWorkerBestEffort } from '@/features/transformers-js/download-verification/dedicated-worker-cleanup';
import type {
  ITransformersJsDownloadWorker,
  ProgressInfo,
  TransformersJsPrefetchResult,
  TransformersJsProgressCallback,
} from '@/features/transformers-js/types';

export interface TransformersJsDownloadWorkerClient {
  prefetchUrls({ urls, progressCallback }: {
    urls: string[];
    progressCallback: TransformersJsProgressCallback;
  }): Promise<TransformersJsPrefetchResult>;
  dispose(): Promise<void>;
}

export function createTransformersJsDownloadWorkerClient(): TransformersJsDownloadWorkerClient {
  if (typeof Worker === 'undefined') {
    return {
      async prefetchUrls() {
        throw new Error('Transformers.js Download Worker requires a browser Worker');
      },
      async dispose() {
      },
    };
  }

  const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module' });
  const remote = wrapWorkerRemote<ITransformersJsDownloadWorker>({ endpoint: worker });
  let disposed = false;
  return {
    async prefetchUrls({ urls, progressCallback }) {
      return await remote.prefetchUrls(
        urls,
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink callback is a positional remote boundary.
        workerProxy({ value: (info: ProgressInfo) => progressCallback({ info }) }),
      );
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      disposeDedicatedWorkerBestEffort({ remote, worker });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
