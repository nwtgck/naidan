import { generateId } from '@/01-models/id';
import type { ImageGenerationAssetId, ImageGenerationRunId, ImageGenerationSessionId } from '@/01-models/ids';
import { planImageGenerationSeeds } from '@/01-models/image-generation';
import type { ImageGenerationAsset, ImageGenerationRun, ImageGenerationRunExecution, ImageGenerationSource } from '@/01-models/image-generation';
import type { ImageGenerationSubmission, ImageGenerationCompletion } from '@/features/stable-diffusion-cpp-browser/generation-submission';
import type { HistoryBinaryFile } from '@/features/stable-diffusion-cpp-browser/history/snapshot';

export type ImageGenerationRunPersistence = {
  create({ run, files }: { run: ImageGenerationRun, files: HistoryBinaryFile[] }): Promise<void>,
  commit({ asset, files }: { asset: ImageGenerationAsset, files: HistoryBinaryFile[] }): Promise<void>,
  update({ run, execution }: { run: ImageGenerationRun, execution: ImageGenerationRunExecution }): Promise<void>,
};

/** A failed acknowledgement retries the SAME identities, bytes and revisions.
 * Completion is deferred until every received image has been persisted. */
export function createImageGenerationRunSink({ sessionId, count, sources, persistence, changed }: {
  sessionId: ImageGenerationSessionId, count: number, sources: ImageGenerationSource[], persistence: ImageGenerationRunPersistence,
  changed: () => void,
}) {
  let run: ImageGenerationRun | undefined;
  let inputs: HistoryBinaryFile[] = [];
  let created = false, started = false, startedAt = 0, finishedAt = 0;
  let completion: ImageGenerationCompletion | undefined;
  let terminal: ImageGenerationRunExecution | undefined;
  let failure = '', saving = false, received = 0;
  const pending = new Map<ImageGenerationAssetId, { asset: ImageGenerationAsset, files: HistoryBinaryFile[] }>();
  let publication: Promise<void> | undefined;
  function publish(): Promise<void> {
    if (publication) return publication;
    const operation = publishPending();
    publication = operation;
    const clear = () => {
      if (publication === operation) publication = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }
  async function publishPending(): Promise<void> {
    if (!run) return;
    saving = true; changed();
    try {
      if (!created) {
        await persistence.create({ run, files: inputs });
        created = true; inputs = [];
      }
      if (!started) {
        const execution = { type: 'running' as const, startedAt };
        await persistence.update({ run, execution });
        run = { ...run, revision: run.revision + 1, execution }; started = true;
      }
      for (const [id, output] of pending) {
        await persistence.commit(output);
        pending.delete(id); changed();
      }
      if (completion && !terminal) {
        // All planned pixels may exist even if the last save acknowledgement
        // failed. In that case retrying the save is enough to complete the run.
        terminal = received === count ? { type: 'completed', finishedAt } : (() => {
          switch (completion.type) {
          case 'completed': return { type: 'failed' as const, finishedAt, message: 'Generation ended before every planned output was received.' };
          case 'cancelled': return { type: 'cancelled' as const, finishedAt };
          case 'failed': return { type: 'failed' as const, finishedAt, message: completion.message || 'Image generation failed.' };
          default: { const exhaustive: never = completion; throw new Error(String(exhaustive)); }
          }
        })();
      }
      if (terminal && run.execution.type === 'running') {
        await persistence.update({ run, execution: terminal });
        run = { ...run, revision: run.revision + 1, execution: terminal };
      }
      failure = '';
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      saving = false; changed();
    }
  }
  const submission: ImageGenerationSubmission = {
    count,
    async accepted({ snapshot, seeds }) {
      if (run) throw new Error('An Image Generation run sink can only accept one request.');
      const plan = planImageGenerationSeeds({ baseSeed: snapshot.request.parameters.seed, count });
      if (plan.length !== seeds.length || plan.some((seed, index) => seed !== seeds[index])) throw new Error('Accepted seeds must match the requested output count and base seed.');
      startedAt = Date.now();
      run = { id: generateId<ImageGenerationRunId>(), sessionId, revision: 0, createdAt: snapshot.createdAt,
        request: structuredClone(snapshot.request), seeds: [...seeds], sources: sources.map(source => ({ ...source })), execution: { type: 'queued' } };
      inputs = snapshot.inputFiles.map(file => ({ ...file }));
      changed(); await publish();
    },
    async output({ index, record, files }) {
      if (!run || !started || completion || index !== received || record.request.parameters.seed !== run.seeds[index]) throw new Error('Image Generation received an unexpected output slot.');
      const asset: ImageGenerationAsset = { id: generateId<ImageGenerationAssetId>(), sessionId, runId: run.id, index,
        createdAt: Date.now(), seed: record.request.parameters.seed, result: structuredClone(record.result), previews: structuredClone(record.previews) };
      const ids = new Set([asset.result.binaryObjectId, ...asset.previews.map(preview => preview.binaryObjectId)]);
      pending.set(asset.id, { asset, files: files.filter(file => ids.has(file.binaryObjectId)) });
      received++; changed(); await publish();
    },
    async finished({ completion: value }) {
      if (completion) throw new Error('An Image Generation run can only finish once.');
      completion = { ...value }; finishedAt = Date.now();
      // Preserve a failed output as pending; do not silently retry in finally.
      if (failure) {
        changed(); return;
      }
      await publish();
    },
  };
  return {
    submission,
    retry: publish,
    snapshot() {
      return { run, received, pending: [...pending.values()], failure, saving, needsRetry: failure.length > 0 };
    },
  };
}
export const TEST_ONLY = {
};
