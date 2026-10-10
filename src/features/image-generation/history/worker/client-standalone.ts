import { wrapWorkerRemote } from '@/utils/worker-transport';
import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/image-history';
import { createLazyImageQuerySession } from '@/features/image-generation/workers/lazy-query-session';
import { historyPageSchema, type ImageHistoryClient, type ImageHistoryWorker } from './types';

export function createImageHistoryClient(): ImageHistoryClient {
  const session = createLazyImageQuerySession<ImageHistoryWorker>({ createWorker: createStandaloneWorker, createRemote: ({ worker }) => wrapWorkerRemote<ImageHistoryWorker>({ endpoint: worker }) });
  return { query: ({ query }) => session.invoke({ run: async ({ remote }) => historyPageSchema.parse(await remote.query({ request: { storageType: 'opfs', query } })) }), dispose: session.dispose };
}

export const TEST_ONLY = {
};
