import * as Comlink from 'comlink';

import type { OpfsEncryptionTransitionProgress } from '@/00-storage/service/opfs-encryption/transition-progress';
import type {
  IOpfsEncryptionWorker,
  OpfsEncryptionWorkerClient,
} from '@/00-storage/service/opfs-encryption/worker/types';
import { createFileProtocolStandaloneWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub-standalone-loader';
import type { IWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub.types';

export async function createOpfsEncryptionWorkerClient(): Promise<OpfsEncryptionWorkerClient> {
  const worker = await createFileProtocolStandaloneWorkerHub();
  const remoteHub = Comlink.wrap<IWorkerHub>(worker);
  const remote = await remoteHub.opfsEncryption as Comlink.Remote<IOpfsEncryptionWorker>;
  return {
    async run({ request, signal, onProgress }) {
      signal?.throwIfAborted();
      const cancel = () => {
        void remote.cancel();
      };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        let remoteOnProgress;
        if (onProgress !== undefined) {
          remoteOnProgress = Comlink.proxy(async ({ progress }: {
            progress: OpfsEncryptionTransitionProgress;
          }) => {
            onProgress({ progress });
          });
        }
        return await remote.run(request, remoteOnProgress);
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
    async dispose() {
      try {
        await remoteHub[Comlink.releaseProxy]();
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
