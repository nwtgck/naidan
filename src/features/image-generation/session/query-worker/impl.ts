import { readImageGenerationSessionIndex } from '@/00-storage/service/image-generation';
import { selectImageGenerationAssets } from '@/features/image-generation/session/asset-query';
import { generationQueryRequestSchema, generationResultToWire, type ImageGenerationQueryResult, type ImageGenerationQueryWorker } from './types';

export function createImageGenerationQueryWorker(): ImageGenerationQueryWorker {
  return {
    async query({ request }) {
      const { store, sessionId, query } = generationQueryRequestSchema.parse(request);
      // Read/recover all three indexes under one storage lock, then apply the
      // feature's gallery policy here, off the rendering thread.
      const snapshot = await readImageGenerationSessionIndex({ store, sessionId });
      const excluded = new Set(snapshot.annotations.items.filter(item => item.state === 'deleting' || item.state === 'deleted').map(item => item.assetId));
      const saved = new Map<ImageGenerationQueryResult['savedImageCounts'][number]['runId'], number>();
      for (const asset of snapshot.assets.items) {
        if (asset.confirmation !== 'unconfirmed' && !excluded.has(asset.id)) {
          saved.set(asset.runId, (saved.get(asset.runId) ?? 0) + 1);
        }
      }
      return generationResultToWire({ value: { runsWithAssets: [...new Set(snapshot.assets.items.map(item => item.runId))], savedImageCounts: [...saved].map(([runId, count]) => ({ runId, count })), deletedAssetIds: snapshot.annotations.items.filter(item => item.state === 'deleted').map(item => item.assetId), pendingDeletions: snapshot.annotations.items.filter(item => item.state === 'deleting').map(({ assetId, sessionId, revision }) => ({ assetId, sessionId, revision })), page: selectImageGenerationAssets({ snapshot, query }), runs: snapshot.runs } });
    },
  };
}

export const TEST_ONLY = {
};
