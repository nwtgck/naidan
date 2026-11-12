import type { ImageGenerationOperationId, ImageGenerationSessionId } from '@/01-models/ids';
import { loadImageGenerationRun, updateImageGenerationRunExecution, type ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import { loadImageGenerationOperation } from '@/00-storage/service/image-generation/operations';
import { withImageOperationExecution } from './operation-lock';
import { imageOperationSaveLockName } from './operation-saves';

/** Explicit recovery is metadata-only. Absence of a component is not evidence
 * of a dead executor: both tab-scoped execution and save ownership must be free. */
export async function recoverImageGenerationOperation({ store, sessionId, operationId }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, operationId: ImageGenerationOperationId,
}): Promise<void> {
  await withImageOperationExecution({
    store,
    operationId,
    execute: async () => {
      await navigator.locks.request(imageOperationSaveLockName({ store, operationId }), { ifAvailable: true }, async lock => {
        if (!lock) {
          throw new Error('Another tab still owns unsaved results for this operation.');
        }
        const operation = await loadImageGenerationOperation({ store, sessionId, operationId });
        for (const id of operation.runIds) {
          const run = await loadImageGenerationRun({ store, sessionId, runId: id });
          if (!run) {
            throw new Error('A generation request is missing.');
          }
          switch (run.execution.type) {
          case 'queued': case 'running':
            await updateImageGenerationRunExecution({ store, sessionId, runId: id, expectedRevision: run.revision, execution: { type: 'interrupted', finishedAt: Date.now() } });
            break;
          case 'completed': case 'cancelled': case 'failed': case 'interrupted': break;
          default: {
            const exhaustive: never = run.execution;
            throw new Error(String(exhaustive));
          }
          }
        }
      });
    },
  });
}

export const TEST_ONLY = {
};
