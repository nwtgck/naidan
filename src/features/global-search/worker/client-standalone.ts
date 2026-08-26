import * as Comlink from 'comlink';
import type { StorageType } from '@/01-models/types';

import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/global-search';
import {
  createStandaloneWorkerSession,
  disposeStandaloneWorkerSession,
  STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
} from '@/features/file-protocol-standalone/worker/standalone-worker-session';
import {
  globalSearchWorkerSearchChatContentResponseSchema,
  type IGlobalSearchWorker,
  type GlobalSearchWorkerClient,
} from './types';
import { createGlobalSearchRemoteContentReader } from './content-reader';

export async function createGlobalSearchWorkerClient({
  storageType,
}: {
  storageType: StorageType,
}): Promise<GlobalSearchWorkerClient> {
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
  const session = await createStandaloneWorkerSession<IGlobalSearchWorker>({ createWorker: createStandaloneWorker });
  const { remote } = session;

  try {
    await remote.configureStorage(storageType, remoteContentReader);
  } catch (error) {
    await disposeStandaloneWorkerSession({
      session,
      beforeRelease: undefined,
      cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
    }).catch(() => undefined);
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
      await disposeStandaloneWorkerSession({
        session,
        beforeRelease: undefined,
        cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
      });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
