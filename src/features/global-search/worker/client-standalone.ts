import * as Comlink from 'comlink';
import type { StorageType } from '@/01-models/types';

import { createFileProtocolStandaloneWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub-standalone-loader';
import type { IWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub.types';
import {
  globalSearchWorkerSearchChatContentResponseSchema,
  type GlobalSearchWorkerClient,
} from './types';
import { createGlobalSearchRemoteContentReader } from './content-reader';

export async function createGlobalSearchWorkerClient({
  storageType,
}: {
  storageType: StorageType,
}): Promise<GlobalSearchWorkerClient> {
  const worker = await createFileProtocolStandaloneWorkerHub();
  const remote = Comlink.wrap<IWorkerHub>(worker);
  const globalSearch = await remote.globalSearch;
  const remoteContentReader = (() => {
    switch (storageType) {
    case 'opfs':
      return undefined;
    case 'local':
    case 'memory':
      return Comlink.proxy(createGlobalSearchRemoteContentReader({ storageType }));
    default: {
      const _ex: never = storageType;
      throw new Error(`Unhandled Global Search storage type: ${_ex}`);
    }
    }
  })();

  try {
    await globalSearch.configureStorage(storageType, remoteContentReader);
  } catch (error) {
    try {
      await remote[Comlink.releaseProxy]();
    } catch {
      // Preserve the storage configuration error.
    } finally {
      worker.terminate();
    }
    throw error;
  }

  return {
    async searchChatContent({ request }) {
      const response = await globalSearch.searchChatContent({
        request: {
          ...request,
          storageType,
        },
      });
      return globalSearchWorkerSearchChatContentResponseSchema.parse(response);
    },
    async dispose() {
      try {
        await remote[Comlink.releaseProxy]();
      } finally {
        worker.terminate();
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
