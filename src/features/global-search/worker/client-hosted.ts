import * as Comlink from 'comlink';
import { GLOBAL_SEARCH_WORKER_NAME } from '@/constants';

import {
  globalSearchWorkerPrepareSessionResponseSchema,
  globalSearchWorkerSearchChatContentResponseSchema,
  globalSearchWorkerSearchTitlesResponseSchema,
  type GlobalSearchWorkerClient,
  type IGlobalSearchWorker,
} from './types';

export async function createGlobalSearchWorkerClient(): Promise<GlobalSearchWorkerClient> {
  const worker = new Worker(
    new URL('./entry.ts', import.meta.url),
    {
      type: 'module',
      name: GLOBAL_SEARCH_WORKER_NAME,
    },
  );
  const remote = Comlink.wrap<IGlobalSearchWorker>(worker);

  return {
    async prepareSession({ request }) {
      const response = await remote.prepareSession({ request });
      return globalSearchWorkerPrepareSessionResponseSchema.parse(response);
    },
    async searchTitles({ request }) {
      const response = await remote.searchTitles({ request });
      return globalSearchWorkerSearchTitlesResponseSchema.parse(response);
    },
    async searchChatContent({ request }) {
      const response = await remote.searchChatContent({ request });
      return globalSearchWorkerSearchChatContentResponseSchema.parse(response);
    },
    async disposeSession({ request }) {
      await remote.disposeSession({ request });
    },
    async dispose() {
      await remote[Comlink.releaseProxy]();
      worker.terminate();
    },
  };
}
