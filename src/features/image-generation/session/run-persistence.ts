import { storageService } from '@/00-storage/service';
import { updateImageGenerationRunExecution, type ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import type { ImageGenerationRunPersistence } from './run-sink';

/** Capture only the original storage address, never a component or current
 * selection. The storage service checks identity, revisions and deletions. */
export function createImageRunPersistence({ store }: { store: ImageGenerationStoreAccess }): ImageGenerationRunPersistence {
  const target = { ...store };
  return {
    create: ({ run, files }) => storageService.publishImageGeneration({ store: target, publication: { type: 'run', run }, files }),
    commit: ({ asset, files }) => storageService.publishImageGeneration({ store: target, publication: { type: 'asset', asset }, files }),
    update: ({ run, execution }) => updateImageGenerationRunExecution({ store: target, sessionId: run.sessionId,
      runId: run.id, execution, expectedRevision: run.revision }),
  };
}
export const TEST_ONLY = {
};
