import { queryImageGenerationHistory } from '@/00-storage/service/image-generation-history';
import { idToRaw } from '@/01-models/ids';
import { historyQuerySchema, type ImageHistoryWorker } from './types';

export function createImageHistoryWorker(): ImageHistoryWorker {
  return {
    async query({ request }) {
      const { storageType, query } = historyQuerySchema.parse(request);
      const page = await queryImageGenerationHistory({ storageType, query });
      return {
        ...page,
        items: page.items.map(item => ({ ...item, id: idToRaw({ id: item.id }), binaryObjectId: idToRaw({ id: item.binaryObjectId }) })),
      };
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
