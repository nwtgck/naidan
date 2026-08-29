import { GLOBAL_SEARCH_WORKER_NAME } from '@/constants';
import type { StorageType } from '@/01-models/types';
import { releaseWorkerRemote, workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';

import {
  globalSearchWorkerSearchChatContentResponseSchema,
  type GlobalSearchWorkerClient,
  type IGlobalSearchWorker,
} from './types';
import { createGlobalSearchRemoteContentReader } from './content-reader';

export async function createGlobalSearchWorkerClient({
  storageType,
}: {
  storageType: StorageType,
}): Promise<GlobalSearchWorkerClient> {
  const worker = new Worker(
    new URL('./entry.ts', import.meta.url),
    {
      type: 'module',
      name: GLOBAL_SEARCH_WORKER_NAME,
    },
  );
  const remote = wrapWorkerRemote<IGlobalSearchWorker>({ endpoint: worker });
  const remoteContentReader = (() => {
    switch (storageType) {
    case 'opfs':
      return undefined;
    case 'local':
    case 'memory':
      return workerProxy({ value: createGlobalSearchRemoteContentReader({ storageType }) });
    default: {
      const _ex: never = storageType;
      throw new Error(`Unhandled Global Search storage type: ${_ex}`);
    }
    }
  })();

  try {
    await remote.configureStorage(storageType, remoteContentReader);
  } catch (error) {
    try {
      await releaseWorkerRemote({ remote });
    } catch {
      // Preserve the storage configuration error.
    } finally {
      worker.terminate();
    }
    throw error;
  }

  return {
    async searchChatContent({ request }) {
      const response = await remote.searchChatContent({
        request: {
          ...request,
          storageType,
        },
      });
      return globalSearchWorkerSearchChatContentResponseSchema.parse(response);
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
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
