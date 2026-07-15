import * as Comlink from 'comlink';
import type {
  IOpfsEncryptionWorker,
  OpfsEncryptionWorkerClient,
} from './types';

export async function createOpfsEncryptionWorkerClient(): Promise<OpfsEncryptionWorkerClient> {
  const worker = new Worker(new URL('./entry.ts', import.meta.url), {
    type: 'module',
    name: 'naidan-opfs-encryption-worker',
  });
  const remote = Comlink.wrap<IOpfsEncryptionWorker>(worker);
  return createClient({
    remote,
    release: async () => {
      try {
        await remote[Comlink.releaseProxy]();
      } finally {
        worker.terminate();
      }
    },
  });
}

function createClient({
  remote,
  release,
}: {
  remote: Comlink.Remote<IOpfsEncryptionWorker>;
  release: () => Promise<void>;
}): OpfsEncryptionWorkerClient {
  return {
    async run({ request, signal }) {
      signal?.throwIfAborted();
      const cancel = () => {
        void remote.cancel();
      };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        return await remote.run({ request });
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
    dispose: release,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createClient,
};
