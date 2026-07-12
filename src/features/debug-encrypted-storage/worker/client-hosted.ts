import * as Comlink from 'comlink';
import { DEBUG_ENCRYPTED_STORAGE_WORKER_NAME } from '@/constants';
import { storageService } from '@/00-storage/service';
import type {
  DebugEncryptedStorageWorkerClient,
  IDebugEncryptedStorageWorker,
} from './types';
import { trackDebugEncryptedStorageWorkerClient } from './client-registry';
import { cloneEncryptedStorageDebugNodeRef } from './clone-node-ref';

export async function createDebugEncryptedStorageWorkerClient(): Promise<DebugEncryptedStorageWorkerClient> {
  const worker = new Worker(new URL('./entry.ts', import.meta.url), {
    type: 'module',
    name: DEBUG_ENCRYPTED_STORAGE_WORKER_NAME,
  });
  const remote = Comlink.wrap<IDebugEncryptedStorageWorker>(worker);
  try {
    await remote.configure(await storageService.createEncryptedStorageDebugCapability());
  } catch (error) {
    try {
      await remote[Comlink.releaseProxy]();
    } catch {
      // Preserve the configuration error.
    } finally {
      worker.terminate();
    }
    throw error;
  }
  return trackDebugEncryptedStorageWorkerClient({
    client: createClient({ remote, worker }),
  });
}

function createClient({
  remote,
  worker,
}: {
  remote: Comlink.Remote<IDebugEncryptedStorageWorker>,
  worker: Worker,
}): DebugEncryptedStorageWorkerClient {
  return {
    async loadNode({ ref }) {
      return await remote.loadNode({
        ref: cloneEncryptedStorageDebugNodeRef({ ref }),
      });
    },
    async loadPersistedJson({ ref }) {
      return await remote.loadPersistedJson({
        ref: cloneEncryptedStorageDebugNodeRef({ ref }),
      });
    },
    async search({ query }) {
      return await remote.search({ query });
    },
    async scanIntegrity() {
      return await remote.scanIntegrity();
    },
    async dispose() {
      try {
        await remote.dispose();
        await remote[Comlink.releaseProxy]();
      } finally {
        worker.terminate();
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createClient,
};
