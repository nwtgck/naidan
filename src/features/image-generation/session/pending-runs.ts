import { generateId } from '@/01-models/id';
import type { ImageGenerationId, ImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationSource } from '@/01-models/image-generation';
import type { ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import type { ImageGenerationSubmission } from '@/features/image-generation/generation-submission';
import { createImageGenerationRunSink, type ImageGenerationRunPersistence } from './run-sink';

type Sink = ReturnType<typeof createImageGenerationRunSink>;
type PendingRun = {
  id: ImageGenerationId,
  store: ImageGenerationStoreAccess,
  sessionId: ImageGenerationSessionId,
  sink: Sink,
  phase: 'running' | 'retired',
};

/** Own failed publications independently of components. The entry is installed
 * before inference; neither navigation nor capacity pressure evicts unsaved work.
 * The byte limit is an admission threshold, not a bound on a single native output:
 * an already computed output is retained even when it crosses that threshold. */
export function createImagePendingRuns({ maxRuns, byteLimit }: { maxRuns: number, byteLimit: number }) {
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || !Number.isSafeInteger(byteLimit) || byteLimit < 1) throw new Error('Invalid pending image limits.');
  const entries = new Map<ImageGenerationId, PendingRun>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch { /* A detached view cannot fail persistence or discard pixels. */ }
    }
  };
  const collect = ({ entry }: { entry: PendingRun }) => {
    const state = entry.sink.snapshot();
    if (entry.phase === 'retired' && !state.saving && !state.needsRetry) entries.delete(entry.id);
    changed();
  };
  const retry = async ({ id }: { id: ImageGenerationId }): Promise<void> => {
    const entry = entries.get(id);
    if (!entry) throw new Error('This pending save has already been saved or discarded.');
    if (entry.phase !== 'retired' || entry.sink.snapshot().saving) throw new Error('Wait for the current run or save to finish.');
    await entry.sink.retry(); collect({ entry });
  };
  return {
    list() {
      return [...entries.values()].map(entry => ({
        id: entry.id,
        store: { ...entry.store },
        sessionId: entry.sessionId,
        phase: entry.phase,
        state: entry.sink.snapshot(),
      }));
    },
    subscribe({ listener }: { listener(): void }) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    create({ store, sessionId, count, sources, persistence }: {
      store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, count: number,
      sources: ImageGenerationSource[], persistence: ImageGenerationRunPersistence,
    }) {
      const blobs = new Set<Blob>();
      for (const entry of entries.values()) {
        const state = entry.sink.snapshot();
        for (const file of [...state.inputs, ...state.pending.flatMap(output => output.files)]) blobs.add(file.blob);
      }
      const bytes = [...blobs].reduce((sum, blob) => sum + blob.size, 0);
      if (entries.size >= maxRuns || bytes >= byteLimit) throw new Error('Save or discard pending image runs before generating again.');
      const id = generateId<ImageGenerationId>();
      // This closure belongs to the registry, not to a mounted workspace.
      const sink = createImageGenerationRunSink({
        sessionId,
        count,
        sources,
        persistence,
        changed: () => {
          const entry = entries.get(id);
          if (entry) collect({ entry });
        },
      });
      const entry: PendingRun = { id, store: { ...store }, sessionId, sink, phase: 'running' };
      let finished = false;
      const submission: ImageGenerationSubmission = {
        ...sink.submission,
        retry: () => retry({ id }),
        async finished({ completion }) {
          finished = true;
          await sink.submission.finished({ completion });
        },
      };
      entries.set(id, entry); changed();
      return {
        id,
        submission,
        snapshot: sink.snapshot,
        async retire(): Promise<void> {
          // A caller that returns or throws without finishing cannot strand a
          // running record, nor turn a missing terminal into a successful run.
          try {
            if (!finished && sink.snapshot().run) {
              finished = true;
              await sink.submission.finished({ completion: { type: 'failed', message: 'Generation ended without a terminal notification.' } });
            }
          } finally {
            entry.phase = 'retired'; collect({ entry });
          }
        },
      };
    },
    // A retained recovery gets this registry address, not a raw sink retry.
    // Discarding the run therefore cannot leave an alternate saving path alive.
    retry,
    discard({ id }: { id: ImageGenerationId }): void {
      const entry = entries.get(id);
      if (!entry) return;
      if (entry.phase !== 'retired' || entry.sink.snapshot().saving) throw new Error('Wait for the current run or save to finish.');
      entries.delete(id); entry.sink.discardPending(); changed();
    },
  };
}
export const imagePendingRuns = createImagePendingRuns({ maxRuns: 8, byteLimit: 128 * 1024 * 1024 });
export const TEST_ONLY = {
};
