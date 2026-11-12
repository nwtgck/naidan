import type { ImageGenerationOperation } from '@/01-models/image-generation';
import type { ImageGenerationOperationId } from '@/01-models/ids';
import type { ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import { withImageOperationExecution } from './operation-lock';

type PendingOperation = {
  operation: ImageGenerationOperation,
  store: ImageGenerationStoreAccess,
  message: string,
  saving: boolean,
  save(): Promise<void>,
};

/** Only retry metadata/inputs. Never retain an inference callback here. A failed
 * acceptance is finalized as interrupted after its membership can be saved. */
export function createImagePendingOperations() {
  const entries = new Map<ImageGenerationOperationId, PendingOperation>();
  const listeners = new Set<() => void>();
  function changed(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch { /* Views cannot prevent preservation. */ }
    }
  }
  return {
    assertCapacity() {
      if (entries.size >= 8) {
        throw new Error('Save or discard pending generation operations first.');
      }
    },
    retain({ operation, store, message, save }: { operation: ImageGenerationOperation, store: ImageGenerationStoreAccess, message: string, save(): Promise<void> }) {
      if (entries.has(operation.id)) {
        throw new Error('A pending generation operation already owns this identity.');
      }
      entries.set(operation.id, { operation: structuredClone(operation), store: { ...store }, message, saving: false, save });
      changed();
    },
    list() {
      return [...entries.values()].map(({ operation, store, message, saving }) => ({ operation, store, message, saving }));
    },
    subscribe({ listener }: { listener(): void }) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async retry({ id }: { id: ImageGenerationOperationId }): Promise<void> {
      const entry = entries.get(id);
      if (!entry || entry.saving) {
        throw new Error('This operation save is unavailable or already running.');
      }
      entry.saving = true;
      changed();
      try {
        await withImageOperationExecution({ store: entry.store, operationId: id, execute: entry.save });
        entries.delete(id);
      } catch (error) {
        entry.message = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        entry.saving = false;
        changed();
      }
    },
    discard({ id }: { id: ImageGenerationOperationId }): void {
      const entry = entries.get(id);
      if (entry?.saving) {
        throw new Error('Wait for operation saving to finish.');
      }
      // This discards the memory retry, not already durable runs or pixels.
      entries.delete(id);
      changed();
    },
  };
}

export const imagePendingOperations = createImagePendingOperations();
export const TEST_ONLY = {
};
