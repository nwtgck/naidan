import { generateId } from '@/01-models/id';
import type { ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import type { HistoryBinaryFile } from '@/features/image-generation/history/snapshot';

export type RecoveredImageEntry = {
  id: ImageGenerationId,
  record: ImageGenerationRecord,
  files: HistoryBinaryFile[],
  retry: (() => Promise<void>) | undefined,
};
/** Recovery ownership outlives a mounted workspace. Reserve before inference so
 * an uncertain terminal result cannot force silent eviction of unsaved pixels. */
export function createImageRecoveryStore({ capacity }: { capacity: number }) {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error('Invalid image recovery budget');
  let used = 0;
  const entries = new Map<ImageGenerationId, { entry: RecoveredImageEntry, bytes: number }>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch { /* Rendering cannot revoke ownership. */ }
    }
  };
  const remove = ({ id }: { id: ImageGenerationId }) => {
    const item = entries.get(id);
    if (item) {
      entries.delete(id); used -= item.bytes; changed();
    }
  };
  return {
    list() {
      return [...entries.values()].map(({ entry }) => entry);
    },
    subscribe({ listener }: { listener(): void }) {
      listeners.add(listener); return () => {
        listeners.delete(listener);
      };
    },
    remove,
    reserve({ bytes }: { bytes: number }) {
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > capacity - used) throw new Error('Save or discard recovered images before generating again.');
      used += bytes;
      let active = true;
      return {
        release() {
          if (active) {
            active = false; used -= bytes;
          }
        },
        retain({ record, files, retry }: { record: ImageGenerationRecord, files: HistoryBinaryFile[], retry: (() => Promise<void>) | undefined }): ImageGenerationId {
          if (!active || record.result.confirmation !== 'unconfirmed') throw new Error('A recovery reservation can retain only one unconfirmed image.');
          const size = files.reduce((total, file) => total + file.blob.size, 0);
          if (size > bytes || !files.some(file => file.binaryObjectId === record.result.binaryObjectId)) throw new Error('Recovered image exceeds its reserved bytes.');
          const id = generateId<ImageGenerationId>();
          const entry = { id, record: structuredClone(record), files: files.map(file => ({ ...file })), retry };
          active = false; used -= bytes - size; entries.set(id, { entry, bytes: size }); changed(); return id;
        },
      };
    },
  };
}
export const imageRecoveryStore = createImageRecoveryStore({ capacity: 128 * 1024 * 1024 });
export const TEST_ONLY = {
};
