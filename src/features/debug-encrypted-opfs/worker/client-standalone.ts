import * as Comlink from 'comlink';
import type { EncryptedOpfsInspectionReader } from '@/00-storage/service/encrypted-opfs';
import { createFileProtocolStandaloneWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub-standalone-loader';
import type { IWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub.types';
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
  const worker = await createFileProtocolStandaloneWorkerHub();
  const remoteHub = Comlink.wrap<IWorkerHub>(worker);
  const remoteWorker = await remoteHub.encryptedOpfsInspection as Comlink.Remote<IEncryptedOpfsInspectionWorker>;
  try {
    await remoteWorker.configure(Comlink.proxy(reader));
  } catch (error) {
    try {
      await remoteHub[Comlink.releaseProxy]();
    } catch {
      // Preserve the worker configuration error.
    } finally {
      worker.terminate();
    }
    throw error;
  }
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
