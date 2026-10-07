import type { ImageGenerationRunId, ImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';

type PendingUse = { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, runId: ImageGenerationRunId };

/** Only published run identities survive route disposal. Retries never create
 * another run, recompute its timestamp, or retain a component/native resource. */
export function createImagePendingSessionUses() {
  const entries = new Map<string, PendingUse>();
  function key({ store, runId }: PendingUse): string {
    return JSON.stringify([store.storageType, store.storeId, runId]);
  }
  return {
    add({ store, sessionId, runId }: PendingUse): void {
      const value = { store: { ...store }, sessionId, runId };
      entries.set(key(value), value);
    },
    list({ store }: { store: ImageGenerationStoreAccess }): PendingUse[] {
      return [...entries.values()].filter(entry => entry.store.storageType === store.storageType && entry.store.storeId === store.storeId)
        .map(entry => ({ ...entry, store: { ...entry.store } }));
    },
    complete({ store, sessionId, runId }: PendingUse): void {
      entries.delete(key({ store, sessionId, runId }));
    },
    removeSession({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): void {
      for (const [id, entry] of entries) {
        if (entry.store.storageType === store.storageType && entry.store.storeId === store.storeId && entry.sessionId === sessionId) entries.delete(id);
      }
    },
  };
}
export const imagePendingSessionUses = createImagePendingSessionUses();
export const TEST_ONLY = {
};
