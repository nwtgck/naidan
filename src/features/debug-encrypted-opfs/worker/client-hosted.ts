import * as Comlink from 'comlink';
import { ENCRYPTED_OPFS_INSPECTION_WORKER_NAME } from '@/constants';
import type { EncryptedOpfsInspectionReader } from '@/00-storage/service/encrypted-opfs';
import {
  encryptedOpfsInspectionOverviewSchema,
  encryptedOpfsInspectedObjectViewSchema,
  encryptedOpfsIntegrityScanResultSchema,
  encryptedOpfsNamespaceResultSchema,
  encryptedOpfsPhysicalObjectPageSchema,
  type EncryptedOpfsInspectionWorkerClient,
  type IEncryptedOpfsInspectionWorker,
} from './types';

export async function createEncryptedOpfsInspectionWorkerClient({
  reader,
}: {
  reader: EncryptedOpfsInspectionReader;
}): Promise<EncryptedOpfsInspectionWorkerClient> {
  const worker = new Worker(new URL('./entry.ts', import.meta.url), {
    type: 'module',
    name: ENCRYPTED_OPFS_INSPECTION_WORKER_NAME,
  });
  const remote = Comlink.wrap<IEncryptedOpfsInspectionWorker>(worker);
  try {
    await remote.configure(Comlink.proxy(reader));
  } catch (error) {
    try {
      await remote[Comlink.releaseProxy]();
    } catch {
      // Preserve the worker configuration error.
    } finally {
      worker.terminate();
    }
    throw error;
  }
  return createClient({ remoteWorker: remote, release: async () => {
    try {
      await remote[Comlink.releaseProxy]();
    } finally {
      worker.terminate();
    }
  } });
}

function createClient({
  remoteWorker,
  release,
}: {
  remoteWorker: Comlink.Remote<IEncryptedOpfsInspectionWorker>;
  release: () => Promise<void>;
}): EncryptedOpfsInspectionWorkerClient {
  return {
    async readOverview() {
      return encryptedOpfsInspectionOverviewSchema.parse(await remoteWorker.readOverview());
    },
    async listPhysicalObjects({ cursor, limit }) {
      return encryptedOpfsPhysicalObjectPageSchema.parse(
        await remoteWorker.listPhysicalObjects({ cursor, limit }),
      );
    },
    async inspectObject({ objectId, binaryPayloadPreviewByteLength }) {
      const result = await remoteWorker.inspectObject({ objectId, binaryPayloadPreviewByteLength });
      return result === undefined ? undefined : encryptedOpfsInspectedObjectViewSchema.parse(result);
    },
    async readNamespace({ maximumEntryCount }) {
      return encryptedOpfsNamespaceResultSchema.parse(
        await remoteWorker.readNamespace({ maximumEntryCount }),
      );
    },
    async runIntegrityScan() {
      return encryptedOpfsIntegrityScanResultSchema.parse(await remoteWorker.runIntegrityScan());
    },
    async cancelCurrentOperation() {
      await remoteWorker.cancelCurrentOperation();
    },
    dispose: release,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createClient,
};
