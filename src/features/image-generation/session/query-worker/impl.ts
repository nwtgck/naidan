import { readImageGenerationSessionIndex } from '@/00-storage/service/image-generation';
import { selectImageGenerationAssets } from '@/features/image-generation/session/asset-query';
import { generationQueryRequestSchema, generationResultToWire, type ImageGenerationQueryWorker } from './types';

export function createImageGenerationQueryWorker(): ImageGenerationQueryWorker {
  return {
    async query({ request }) {
      const { store, sessionId, query } = generationQueryRequestSchema.parse(request);
      // Read/recover all three indexes under one storage lock, then apply the
      // feature's gallery policy here, off the rendering thread.
      const snapshot = await readImageGenerationSessionIndex({ store, sessionId });
      return generationResultToWire({ value: { runsWithAssets: [...new Set(snapshot.assets.items.map(item => item.runId))], deletedAssetIds: snapshot.annotations.items.filter(item => item.state === 'deleted').map(item => item.assetId), pendingDeletions: snapshot.annotations.items.filter(item => item.state === 'deleting').map(({ assetId, sessionId, revision }) => ({ assetId, sessionId, revision })), page: selectImageGenerationAssets({ snapshot, query }), runs: snapshot.runs } });
    },
  };
}
export const TEST_ONLY = {
};
