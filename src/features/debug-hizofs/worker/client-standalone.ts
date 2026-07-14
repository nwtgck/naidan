import * as Comlink from 'comlink';
import type { HizoFSInspectionReader } from '@/00-storage/service/hizofs';
import { createFileProtocolStandaloneWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub-standalone-loader';
import type { IWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub.types';
import {
  hizoFSInspectionOverviewSchema,
  hizoFSInspectedObjectViewSchema,
  hizoFSIntegrityScanResultSchema,
  hizoFSNamespaceResultSchema,
  hizoFSPhysicalObjectPageSchema,
  hizoFSResolvedNodeSchema,
  hizoFSResolvedPathSchema,
  hizoFSSuperblockSlotSchema,
  type HizoFSInspectionWorkerClient,
  type IHizoFSInspectionWorker,
} from './types';

export async function createHizoFSInspectionWorkerClient({
  reader,
}: {
  reader: HizoFSInspectionReader;
}): Promise<HizoFSInspectionWorkerClient> {
  const worker = await createFileProtocolStandaloneWorkerHub();
  const remoteHub = Comlink.wrap<IWorkerHub>(worker);
  const remoteWorker = await remoteHub.hizoFSInspection as Comlink.Remote<IHizoFSInspectionWorker>;
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
      return hizoFSInspectionOverviewSchema.parse(await remoteWorker.readOverview());
    },
    async listPhysicalObjects({ cursor, limit }) {
      return hizoFSPhysicalObjectPageSchema.parse(
        await remoteWorker.listPhysicalObjects({ cursor, limit }),
      );
    },
    async inspectObject({ objectId, binaryPreviewByteLength }) {
      const result = await remoteWorker.inspectObject({ objectId, binaryPreviewByteLength });
      return result === undefined ? undefined : hizoFSInspectedObjectViewSchema.parse(result);
    },
    async inspectSuperblockSlot({ slot, binaryPreviewByteLength }) {
      return hizoFSSuperblockSlotSchema.parse(
        await remoteWorker.inspectSuperblockSlot({ slot, binaryPreviewByteLength }),
      );
    },
    async readNode({ commitObjectId, nodeId, logicalPath, maximumDirectoryEntryCount }) {
      return hizoFSResolvedNodeSchema.parse(await remoteWorker.readNode({
        commitObjectId,
        nodeId,
        logicalPath,
        maximumDirectoryEntryCount,
      }));
    },
    async readPath({ commitObjectId, logicalPath, maximumDirectoryEntryCount }) {
      return hizoFSResolvedPathSchema.parse(await remoteWorker.readPath({
        commitObjectId,
        logicalPath,
        maximumDirectoryEntryCount,
      }));
    },
    async readNamespace({ maximumEntryCount }) {
      return hizoFSNamespaceResultSchema.parse(
        await remoteWorker.readNamespace({ maximumEntryCount }),
      );
    },
    async runIntegrityScan() {
      return hizoFSIntegrityScanResultSchema.parse(await remoteWorker.runIntegrityScan());
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
