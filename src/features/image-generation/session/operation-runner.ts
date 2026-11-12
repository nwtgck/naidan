import { generateId } from '@/01-models/id';
import type { ImageGenerationOperationId, ImageGenerationRunId, ImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationOperation, ImageGenerationRun, ImageGenerationSource } from '@/01-models/image-generation';
import type { PreparedImageGeneration } from '@/features/image-generation/generation-submission';
import type { HistoryBinaryFile } from '@/features/image-generation/history/snapshot';
import { storageService } from '@/00-storage/service';
import { updateImageGenerationRunExecution, type ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import { saveImageGenerationOperation } from '@/00-storage/service/image-generation/operations';
import { createImageRunPersistence } from './run-persistence';
import { imagePendingRuns } from './pending-runs';
import { imagePendingOperations } from './pending-operations';
import { imagePendingSessionUses } from './pending-session-uses';
import { protectImageOperationSaves } from './operation-saves';
import { withImageOperationExecution } from './operation-lock';

export type ImageOperationProgress = {
  operation: ImageGenerationOperation, index: number, total: number, phase: 'accepting' | 'running' | 'finishing',
  status: 'active' | 'completed' | 'cancelled' | 'failed',
  completedImages: number, savedImages: number, totalImages: number,
  request: { runId: ImageGenerationRunId, received: number, total: number, saving: boolean } | undefined,
};

/** All requests are resolved before this function is called. Publication of the
 * immutable parent is the acceptance boundary; no native work precedes it. */
export async function runImageGenerationOperation({ store, sessionId, plans, sources, signal, progress }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId,
  plans: PreparedImageGeneration[], sources: ImageGenerationSource[], signal: AbortSignal,
  progress({ state }: { state: ImageOperationProgress }): void,
}): Promise<ImageGenerationOperation> {
  imagePendingOperations.assertCapacity();
  if (!plans.length || plans.length > 128 || plans.reduce((total, plan) => total + plan.seeds.length, 0) > 512) {
    throw new Error('Invalid generation operation size.');
  }
  signal.throwIfAborted();
  const operationId = generateId<ImageGenerationOperationId>();
  const requests: { run: ImageGenerationRun, files: HistoryBinaryFile[] }[] = plans.map(plan => ({
    run: {
      operationId,
      acceptedOrder: undefined,
      id: generateId<ImageGenerationRunId>(),
      sessionId,
      revision: 0,
      createdAt: plan.snapshot.createdAt,
      request: structuredClone(plan.snapshot.request),
      seeds: [...plan.seeds],
      sources: sources.map(source => ({ ...source })),
      execution: { type: 'queued' },
    },
    files: plan.snapshot.inputFiles.map(file => ({ ...file })),
  }));
  const operation: ImageGenerationOperation = { id: operationId, sessionId, createdAt: Date.now(), runIds: requests.map(({ run }) => run.id) };
  const destination = { ...store };
  // Safe to keep for saving retries: none of these closures captures `plans`,
  // `progress`, a view, or a native execution capability.
  const accept = createOperationAcceptance({ store: destination, operation, requests });
  const totalImages = plans.reduce((total, plan) => total + plan.seeds.length, 0);
  const imageCounts = new Map<ImageGenerationRunId, { received: number, saved: number }>();
  let activeRequest: ImageOperationProgress['request'];
  const notify = ({ index, phase, status }: { index: number, phase: ImageOperationProgress['phase'], status: ImageOperationProgress['status'] }) => {
    try {
      progress({
        state: {
          operation: structuredClone(operation),
          index,
          total: plans.length,
          phase,
          status,
          totalImages,
          completedImages: [...imageCounts.values()].reduce((total, counts) => total + counts.received, 0),
          savedImages: [...imageCounts.values()].reduce((total, counts) => total + counts.saved, 0),
          request: activeRequest && { ...activeRequest },
        },
      });
    } catch { /* Presentation cannot abort durable work. */ }
  };
  const execute = async (): Promise<ImageGenerationOperation> => {
    notify({ index: 0, phase: 'accepting', status: 'active' });
    try {
      await accept();
    } catch (error) {
      const save = createOperationFinalization({ store: destination, requests, reason: 'interrupted', accept });
      imagePendingOperations.retain({ store: destination, operation, message: error instanceof Error ? error.message : String(error), save });
      notify({ index: 0, phase: 'finishing', status: signal.aborted ? 'cancelled' : 'failed' });
      throw error;
    }
    let next = 0, currentRequest = 0;
    let problem: unknown;
    try {
      while (next < plans.length) {
        currentRequest = next;
        signal.throwIfAborted();
        const index = next;
        const planned = requests[index]!;
        const owner = imagePendingRuns.create({
          store: destination,
          sessionId,
          count: planned.run.seeds.length,
          sources: planned.run.sources,
          plannedRun: planned.run,
          persistence: createImageRunPersistence({ store: destination, operation }),
        });
        const observe = () => {
          const state = owner.snapshot();
          const unsaved = state.pending.filter(output => output.asset.result.confirmation !== 'unconfirmed').length;
          imageCounts.set(planned.run.id, { received: state.received, saved: Math.max(0, state.received - unsaved) });
          activeRequest = { runId: planned.run.id, received: state.received, total: planned.run.seeds.length, saving: state.saving };
          notify({ index, phase: 'running', status: 'active' });
        };
        const unsubscribe = imagePendingRuns.subscribe({ listener: observe });
        observe();
        try {
          await plans[index]!.execute({ submission: owner.submission, signal });
        } finally {
          try {
            await owner.retire();
          } finally {
            // An accepted sink owns this run, including lost acknowledgements
            // and unsaved pixels. Never mutate it through the queued-tail path.
            if (owner.snapshot().run) {
              next = index + 1;
            }
            observe();
            unsubscribe();
          }
        }
        const state = owner.snapshot();
        if (state.needsRetry) {
          throw new Error(state.failure || 'Save the pending generation results before continuing.');
        }
        const execution = state.run?.execution;
        if (!execution) {
          const completion = state.completion;
          switch (completion?.type) {
          case 'failed': throw new Error(completion.message);
          case 'cancelled': throw new Error('Generation was cancelled before the request was accepted.');
          case 'interrupted': throw new Error('Generation was interrupted before the request was accepted.');
          case 'completed': case undefined: throw new Error('Generation ended before the request was accepted.');
          default: {
            const exhaustive: never = completion;
            throw new Error(String(exhaustive));
          }
          }
        }
        switch (execution.type) {
        case 'completed': break;
        case 'failed': throw new Error(execution.message);
        case 'queued': case 'running': case 'cancelled': case 'interrupted': throw new Error('Generation stopped before all requests completed.');
        default: {
          const exhaustive: never = execution;
          throw new Error(String(exhaustive));
        }
        }
      }
    } catch (error) {
      problem = new Error(`Request ${currentRequest + 1}/${plans.length}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    notify({ index: next, phase: 'finishing', status: 'active' });
    const remaining = requests.slice(next);
    if (remaining.length) {
      const save = createOperationFinalization({ store: destination, requests: remaining, reason: signal.aborted ? 'cancelled' : 'interrupted', accept: undefined });
      try {
        await save();
      } catch (error) {
        imagePendingOperations.retain({ store: destination, operation, message: error instanceof Error ? error.message : String(error), save });
        problem ??= error;
      }
    }
    if (problem !== undefined) {
      notify({ index: next, phase: 'finishing', status: signal.aborted ? 'cancelled' : 'failed' });
      throw problem;
    }
    notify({ index: next, phase: 'finishing', status: 'completed' });
    return operation;
  };
  return withImageOperationExecution({
    store: destination,
    operationId,
    execute: async () => {
      try {
        return await execute();
      } finally {
        await protectImageOperationSaves({ store: destination, operationId });
      }
    },
  });
}

function createOperationAcceptance({ store, operation, requests }: {
  store: ImageGenerationStoreAccess, operation: ImageGenerationOperation, requests: { run: ImageGenerationRun, files: HistoryBinaryFile[] }[],
}): () => Promise<void> {
  return async () => {
    for (const request of requests) {
      await storageService.publishImageGeneration({ store, publication: { type: 'run', run: request.run }, files: request.files });
    }
    await saveImageGenerationOperation({ store, operation });
    const first = requests[0]!;
    imagePendingSessionUses.add({ store, sessionId: operation.sessionId, runId: first.run.id });
  };
}

function createOperationFinalization({ store, requests, reason, accept }: {
  store: ImageGenerationStoreAccess, requests: { run: ImageGenerationRun, files: HistoryBinaryFile[] }[],
  reason: 'cancelled' | 'interrupted', accept: (() => Promise<void>) | undefined,
}): () => Promise<void> {
  const finishedAt = Date.now();
  let accepted = accept === undefined;
  let index = 0;
  return async () => {
    if (!accepted) {
      await accept!();
      accepted = true;
    }
    for (; index < requests.length; index++) {
      const { run } = requests[index]!;
      await updateImageGenerationRunExecution({ store, sessionId: run.sessionId, runId: run.id, expectedRevision: run.revision, execution: { type: reason, finishedAt } });
    }
  };
}

export const TEST_ONLY = {
};
