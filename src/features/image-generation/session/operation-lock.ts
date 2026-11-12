import { idToRaw, type ImageGenerationOperationId } from '@/01-models/ids';
import type { ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';

/** Execution ownership is deliberately separate from the short metadata lock.
 * Recovery uses this same lease and cannot interrupt a live owner in another tab. */
export async function withImageOperationExecution<T>({ store, operationId, execute }: {
  store: ImageGenerationStoreAccess, operationId: ImageGenerationOperationId, execute(): Promise<T>,
}): Promise<T> {
  if (!navigator.locks?.request) {
    throw new Error('Image generation execution requires Web Locks.');
  }
  return navigator.locks.request(`naidan-image-operation:${idToRaw({ id: store.storeId })}:${idToRaw({ id: operationId })}`, { ifAvailable: true }, async lock => {
    if (!lock) {
      throw new Error('This generation operation is still active in another tab.');
    }
    return execute();
  });
}

export const TEST_ONLY = {
};
