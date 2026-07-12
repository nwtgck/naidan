import * as Comlink from 'comlink';
import { storageService } from '@/00-storage/service';
import { createFileProtocolStandaloneWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub-standalone-loader';
import type { IWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub.types';
import type {
  DebugEncryptedStorageWorkerClient,
  IDebugEncryptedStorageWorker,
} from './types';
import { trackDebugEncryptedStorageWorkerClient } from './client-registry';
import { cloneEncryptedStorageDebugNodeRef } from './clone-node-ref';

export async function createDebugEncryptedStorageWorkerClient(): Promise<DebugEncryptedStorageWorkerClient> {
  const worker = await createFileProtocolStandaloneWorkerHub();
  const hub = Comlink.wrap<IWorkerHub>(worker);
  const remote = await hub.debugEncryptedStorage;
  try {
    await remote.configure(await storageService.createEncryptedStorageDebugCapability());
  } catch (error) {
    await disposeStandaloneResources({
      remote,
      hub,
      worker,
      disposeRemote: true,
    }).catch(() => undefined);
    throw error;
  }
  return trackDebugEncryptedStorageWorkerClient({
    client: createClient({ remote, hub, worker }),
  });
}

function createClient({
  remote,
  hub,
  worker,
}: {
  remote: Comlink.Remote<IDebugEncryptedStorageWorker>,
  hub: Comlink.Remote<IWorkerHub>,
  worker: Worker,
}): DebugEncryptedStorageWorkerClient {
  return {
    async loadNode({ ref }) {
      return await remote.loadNode({
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
      await disposeStandaloneResources({
        remote,
        hub,
        worker,
        disposeRemote: true,
      });
    },
  };
}

async function disposeStandaloneResources({
  remote,
  hub,
  worker,
  disposeRemote,
}: {
  remote: Comlink.Remote<IDebugEncryptedStorageWorker>,
  hub: Comlink.Remote<IWorkerHub>,
  worker: Worker,
  disposeRemote: boolean,
}): Promise<void> {
  let firstError: unknown;
  if (disposeRemote) {
    try {
      await remote.dispose();
    } catch (error) {
      firstError = error;
    }
  }
  try {
    await remote[Comlink.releaseProxy]();
  } catch (error) {
    firstError ??= error;
  }
  try {
    await hub[Comlink.releaseProxy]();
  } catch (error) {
    firstError ??= error;
  } finally {
    worker.terminate();
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createClient,
  disposeStandaloneResources,
};
