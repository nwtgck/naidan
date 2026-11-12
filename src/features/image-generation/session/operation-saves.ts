import { idToRaw, type ImageGenerationOperationId } from '@/01-models/ids';
import type { ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import { imagePendingRuns } from './pending-runs';
import { imagePendingOperations } from './pending-operations';

export function imageOperationSaveLockName({ store, operationId }: { store: ImageGenerationStoreAccess, operationId: ImageGenerationOperationId }): string {
  return `naidan-image-operation-save:${idToRaw({ id: store.storeId })}:${idToRaw({ id: operationId })}`;
}

const owners = new Map<string, Promise<void>>();

/** Acquire before releasing execution ownership. The second lease outlives the
 * view while unsaved pixels/metadata are owned by this tab. Saving retries do not
 * need this lease again; recovery in another tab must acquire both leases. */
export async function protectImageOperationSaves({ store, operationId }: { store: ImageGenerationStoreAccess, operationId: ImageGenerationOperationId }): Promise<void> {
  const matches = ({ candidate }: { candidate: ImageGenerationStoreAccess }) => candidate.storeId === store.storeId && candidate.storageType === store.storageType;
  const pending = () => imagePendingRuns.list().some(entry => matches({ candidate: entry.store }) && entry.state.run?.operationId === operationId && entry.state.needsRetry)
    || imagePendingOperations.list().some(entry => matches({ candidate: entry.store }) && entry.operation.id === operationId);
  if (!pending()) {
    return;
  }
  const key = imageOperationSaveLockName({ store, operationId });
  const existing = owners.get(key);
  if (existing) {
    await existing;
    return;
  }
  const acquired = Promise.withResolvers<void>();
  owners.set(key, acquired.promise);
  void navigator.locks.request(key, async () => {
    let unsubscribeRuns: (() => void) | undefined;
    let unsubscribeOperations: (() => void) | undefined;
    try {
      await new Promise<void>(resolve => {
        const changed = () => {
          if (!pending()) {
            resolve();
          }
        };
        unsubscribeRuns = imagePendingRuns.subscribe({ listener: changed });
        unsubscribeOperations = imagePendingOperations.subscribe({ listener: changed });
        acquired.resolve();
        changed();
      });
    } finally {
      unsubscribeRuns?.();
      unsubscribeOperations?.();
    }
  }).catch(acquired.reject).finally(() => {
    owners.delete(key);
  });
  await acquired.promise;
}

export const TEST_ONLY = {
};
