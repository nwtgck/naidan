import { saveImageGenerationOperation } from '@/00-storage/service/image-generation/operations';
import type { ImageGenerationOperation } from '@/01-models/image-generation';
import { imagePendingSessionUses } from './pending-session-uses';
import { storageService } from '@/00-storage/service';
import { updateImageGenerationRunExecution, type ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import type { ImageGenerationRunPersistence } from './run-sink';

/** Capture only the original storage address, never a component or current
 * selection. The storage service checks identity, revisions and deletions. */
export function createImageRunPersistence({ store, operation }: { store: ImageGenerationStoreAccess, operation?: ImageGenerationOperation }): ImageGenerationRunPersistence {
  const target = { ...store };
  return {
    async create({ run, files }) {
      await storageService.publishImageGeneration({ store: target, publication: { type: 'run', run }, files });
      if (run.operationId) {
        await saveImageGenerationOperation({ store: target, operation: operation ?? { id: run.operationId, sessionId: run.sessionId, createdAt: run.createdAt, runIds: [run.id] } });
      }
      if (!operation || operation.runIds[0] === run.id) {
        imagePendingSessionUses.add({ store: target, sessionId: run.sessionId, runId: run.id });
      }
    },
    commit: ({ asset, files }) => storageService.publishImageGeneration({ store: target, publication: { type: 'asset', asset }, files }),
    update: ({ run, execution }) => updateImageGenerationRunExecution({
      store: target,
      sessionId: run.sessionId,
      runId: run.id,
      execution,
      expectedRevision: run.revision,
    }),
  };
}

export const TEST_ONLY = {
};
