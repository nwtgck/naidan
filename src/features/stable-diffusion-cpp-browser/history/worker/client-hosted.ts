import { releaseWorkerRemote, wrapWorkerRemote } from '@/utils/worker-transport';
import { historyPageSchema, type ImageHistoryClient, type ImageHistoryWorker } from './types';

export function createImageHistoryClient(): ImageHistoryClient {
  const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'naidan-image-history' });
  const remote = wrapWorkerRemote<ImageHistoryWorker>({ endpoint: worker });
  return {
    async query({ query }) {
      return historyPageSchema.parse(await remote.query({ request: { storageType: 'opfs', query } }));
    },
    async dispose() {
      try {
        await releaseWorkerRemote({ remote });
      } finally {
        worker.terminate();
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
