import type { ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import { copyImageGenerationSnapshot, type HistoryBinaryFile } from './snapshot';
import { protectUnsavedImages } from '@/features/image-generation/execution/unsaved-exit';

type SaveEvent = { type: 'changed' } | { type: 'saved' | 'discarded', id: ImageGenerationId };
type Publication = { record: ImageGenerationRecord, files: HistoryBinaryFile[] };
type Entry = {
  publication: Publication,
  save({ record, files }: Publication): Promise<void>,
  phase: 'pending' | 'saving' | 'failed',
  failure: string,
  task: Promise<void> | undefined,
};
function copyPublication({ record, files }: Publication): Publication {
  const { id, createdAt, request, result, previews, ...rest } = record;
  rest satisfies Record<PropertyKey, never>;
  const snapshot = copyImageGenerationSnapshot({ snapshot: { id, createdAt, request, inputFiles: files } });
  return { record: { id, createdAt, request: snapshot.request, result: { ...result }, previews: previews.map(image => ({ ...image })) }, files: snapshot.inputFiles };
}

/** Direct generation has no workspace submission. Its completed pixels still
 * belong to a save owner, not to a gallery entry or a mounted controller.
 * Capacity limits new work; an already computed image is never silently evicted. */
export function createPendingImageHistory({ maxEntries, byteLimit }: { maxEntries: number, byteLimit: number }) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(byteLimit) || byteLimit < 1) throw new Error('Invalid pending image limits.');
  const entries = new Map<ImageGenerationId, Entry>();
  const listeners = new Set<({ event }: { event: SaveEvent }) => void>();
  function changed({ event }: { event: SaveEvent }): void {
    for (const listener of listeners) {
      try {
        listener({ event });
      } catch { /* A failed or detached view cannot discard retained pixels. */ }
    }
  }
  return {
    assertCapacity(): void {
      const blobs = new Set([...entries.values()].flatMap(entry => entry.publication.files.map(file => file.blob)));
      if (entries.size >= maxEntries || [...blobs].reduce((total, blob) => total + blob.size, 0) >= byteLimit) throw new Error('Save or discard pending image history before generating again.');
    },
    retain({ record, files, save }: Publication & { save({ record, files }: Publication): Promise<void> }): ImageGenerationId {
      if (entries.has(record.id)) throw new Error('This image history publication is already retained.');
      entries.set(record.id, { publication: copyPublication({ record, files }), save, phase: 'pending', failure: '', task: undefined });
      changed({ event: { type: 'changed' } });
      return record.id;
    },
    list() {
      return [...entries.values()].map(entry => ({ ...copyPublication(entry.publication), phase: entry.phase, failure: entry.failure }));
    },
    subscribe({ listener }: { listener({ event }: { event: SaveEvent }): void }) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry({ id }: { id: ImageGenerationId }): Promise<void> {
      const entry = entries.get(id);
      if (!entry) return Promise.reject(new Error('This image has already been saved or discarded.'));
      if (entry.task) return entry.task;
      entry.phase = 'saving'; entry.failure = '';
      // Defer the writer until task is installed; reentrant view notifications
      // cannot start a second publication. Reuse the same immutable IDs and bytes.
      let completed = false;
      const task = Promise.resolve().then(() => entry.save(entry.publication)).then(() => {
        entries.delete(id); completed = true;
      }, (cause: unknown) => {
        entry.phase = 'failed'; entry.failure = cause instanceof Error ? cause.message : String(cause); throw cause;
      }).finally(() => {
        entry.task = undefined; changed({ event: completed ? { type: 'saved', id } : { type: 'changed' } });
      });
      entry.task = task; changed({ event: { type: 'changed' } });
      return task;
    },
    discard({ id }: { id: ImageGenerationId }): void {
      const entry = entries.get(id);
      if (!entry) return;
      if (entry.task) throw new Error('Wait for the current save to finish.');
      entries.delete(id); changed({ event: { type: 'discarded', id } });
    },
  };
}
export const pendingImageHistory = createPendingImageHistory({ maxEntries: 32, byteLimit: 128 * 1024 * 1024 });
if (typeof window !== 'undefined') {
  protectUnsavedImages({ target: window, subscribe: pendingImageHistory.subscribe, hasPending: () => pendingImageHistory.list().length > 0 });
}
export const TEST_ONLY = {
};
