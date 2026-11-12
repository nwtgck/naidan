import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import * as storage from '@/00-storage/service/image-generation';
import { createImageGenerationStorageHarness, generationRunFixture, generationSessionFixture } from '@/00-storage/service/image-generation/index.test-support';
import { listImageGenerationOperations } from '@/00-storage/service/image-generation/operations';
import { toImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationOperation } from '@/01-models/image-generation';
import { copyImageGenerationSnapshot, finishImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
import type { PreparedImageGeneration } from '@/features/image-generation/generation-submission';
import { runImageGenerationOperation } from './operation-runner';
import { recoverImageGenerationOperation } from './operation-recovery';
import { withImageOperationExecution } from './operation-lock';
import { imagePendingRuns } from './pending-runs';
import { imagePendingOperations } from './pending-operations';
import { imageOperationSaveLockName } from './operation-saves';
import { imagePendingSessionUses } from './pending-session-uses';

const mocks = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('@/00-storage/service', () => ({ storageService: { publishImageGeneration: mocks.publish } }));
let fs: ReturnType<typeof createImageGenerationStorageHarness>;
let store: storage.ImageGenerationStoreAccess;
const session = generationSessionFixture({ id: 'session-aa' });
let calls: string[];
let failAsset: boolean;

beforeEach(async () => {
  fs = createImageGenerationStorageHarness();
  const catalog = (await storage.openImageGenerationStore({ storageType: 'opfs', creation: 'allow' }))!;
  store = { storageType: 'opfs', storeId: catalog.id };
  await storage.saveImageGenerationSession({ store, session, expectedRevision: undefined });
  calls = [];
  failAsset = false;
  mocks.publish.mockReset();
  mocks.publish.mockImplementation(async ({ publication }: { publication: { type: 'run', run: Parameters<typeof storage.createImageGenerationRun>[0]['run'] } | { type: 'asset', asset: Parameters<typeof storage.commitImageGenerationAsset>[0]['asset'] } }) => {
    if (publication.type === 'run') {
      await storage.createImageGenerationRun({ store, run: publication.run, writeInputs: async () => {} });
    } else {
      await storage.commitImageGenerationAsset({ store, asset: publication.asset, writeImages: async () => {} });
      if (failAsset) {
        failAsset = false;
        throw new Error('lost asset acknowledgement');
      }
    }
  });
});

afterEach(async () => {
  for (const entry of imagePendingRuns.list()) {
    imagePendingRuns.discard({ id: entry.id });
  }
  for (const entry of imagePendingOperations.list()) {
    imagePendingOperations.discard({ id: entry.operation.id });
  }
  imagePendingSessionUses.removeSession({ store, sessionId: session.id });
  await flushPromises();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function plan({ name, count = 1, fail = false, cancel, during }: { name: string, count?: number, fail?: boolean, cancel?: AbortController, during?: () => Promise<void> }): PreparedImageGeneration {
  const run = generationRunFixture({ id: `unused-${name}`, sessionId: session.id, count, seed: '9007199254740993' });
  run.request.parameters.prompt = name;
  run.request.imageInputs = { initImage: undefined, referenceImages: [], strength: 0.75 };
  const snapshot = { id: toImageGenerationId({ raw: `image-${name}` }), request: run.request, inputFiles: [], createdAt: 1 };
  return {
    get snapshot() {
      return copyImageGenerationSnapshot({ snapshot });
    },
    seeds: run.seeds,
    async execute({ submission }) {
      if (!submission) {
        throw new Error('Test requires a durable submission.');
      }
      calls.push(name);
      // Parent and every sibling must already exist before any inference.
      const operations = await listImageGenerationOperations({ store, sessionId: session.id });
      expect(operations.items).toHaveLength(1);
      await submission.accepted({ snapshot, seeds: run.seeds });
      await during?.();
      if (cancel) {
        cancel.abort();
        await submission.finished({ completion: { type: 'cancelled' } });
        return;
      }
      if (fail) {
        await submission.finished({ completion: { type: 'failed', message: 'native failed' } });
        return;
      }
      try {
        for (const [index, seed] of run.seeds.entries()) {
          const output = finishImageGenerationSnapshot({ snapshot: { ...snapshot, request: { ...snapshot.request, parameters: { ...snapshot.request.parameters, seed } } }, result: { png: new Blob(['pixels']), width: 256, height: 256, modelVersion: 'test', uniformOutput: false }, previews: [], elapsedMs: 1 });
          await submission.output({ index, ...output });
        }
        await submission.finished({ completion: { type: 'completed' } });
      } catch (error) {
        await submission.finished({ completion: { type: 'failed', message: String(error) } });
        throw error;
      }
    },
  };
}

async function states({ operation }: { operation: ImageGenerationOperation }): Promise<string[]> {
  return Promise.all(operation.runIds.map(async runId => (await storage.loadImageGenerationRun({ store, sessionId: session.id, runId }))!.execution.type));
}

const signal = () => new AbortController().signal;

describe('generation operation coordinator with real metadata storage', () => {
  it('accepts all requests once and runs them in order under one operation in the same session', async () => {
    const operation = await runImageGenerationOperation({ store, sessionId: session.id, plans: [plan({ name: 'red', count: 2 }), plan({ name: 'blue' })], sources: [], signal: signal(), progress: vi.fn() });
    expect(calls).toEqual(['red', 'blue']);
    expect(await states({ operation })).toEqual(['completed', 'completed']);
    expect((await storage.listImageGenerationSessions({ store })).items).toHaveLength(1);
    expect(imagePendingRuns.list()).toHaveLength(0);
  });

  it.each(['failure', 'cancel'] as const)('preserves earlier results and never starts later requests after %s', async mode => {
    const abort = new AbortController();
    await expect(runImageGenerationOperation({ store, sessionId: session.id, plans: [plan({ name: 'red' }), plan({ name: 'blue', fail: mode === 'failure', cancel: mode === 'cancel' ? abort : undefined }), plan({ name: 'green' })], sources: [], signal: abort.signal, progress: vi.fn() })).rejects.toThrow();
    const operation = (await listImageGenerationOperations({ store, sessionId: session.id })).items[0]!;
    expect(calls).toEqual(['red', 'blue']);
    expect(await states({ operation })).toEqual(['completed', mode === 'failure' ? 'failed' : 'cancelled', mode === 'failure' ? 'interrupted' : 'cancelled']);
  });

  it('does not let presentation errors cancel accepted work', async () => {
    const operation = await runImageGenerationOperation({
      store,
      sessionId: session.id,
      plans: [plan({ name: 'red' })],
      sources: [],
      signal: signal(),
      progress() {
        throw new Error('view disposed');
      },
    });
    expect(await states({ operation })).toEqual(['completed']);
  });

  it.each([0, 1])('reports the original failure and request position when request %i fails before acceptance', async index => {
    const plans = [plan({ name: 'red' }), plan({ name: 'blue' }), plan({ name: 'green' })];
    const original = plans[index]!;
    plans[index] = {
      ...original,
      async execute({ submission }) {
        await submission!.finished({ completion: { type: 'failed', message: 'The prepared model configuration does not match.' } });
      },
    };
    await expect(runImageGenerationOperation({ store, sessionId: session.id, plans, sources: [], signal: signal(), progress: vi.fn() })).rejects.toThrow(`Request ${index + 1}/3: The prepared model configuration does not match.`);
    const operation = (await listImageGenerationOperations({ store, sessionId: session.id })).items[0]!;
    expect(calls).toEqual(index === 0 ? [] : ['red']);
    expect(await states({ operation })).toEqual(index === 0 ? ['interrupted', 'interrupted', 'interrupted'] : ['completed', 'interrupted', 'interrupted']);
    expect(imagePendingRuns.list()).toHaveLength(0);
  });

  it('retries failed parent acceptance without inference or new identities', async () => {
    let failed = false;
    await expect(runImageGenerationOperation({
      store,
      sessionId: session.id,
      plans: [plan({ name: 'red' }), plan({ name: 'blue' })],
      sources: [],
      signal: signal(),
      progress({ state }) {
        if (state.phase === 'accepting' && !failed) {
          failed = true;
          fs.faults.add(`close:/naidan-storage/experimental/image-generation/sessions/aa/session-aa/operations/${String(state.operation.id).slice(-2).toLowerCase()}/${String(state.operation.id)}.json`);
        }
      },
    })).rejects.toThrow('Injected');
    expect(calls).toEqual([]);
    const pending = imagePendingOperations.list()[0]!;
    expect(pending).toBeDefined();
    await imagePendingOperations.retry({ id: pending.operation.id });
    expect(calls).toEqual([]);
    expect(await states({ operation: pending.operation })).toEqual(['interrupted', 'interrupted']);
    expect((await listImageGenerationOperations({ store, sessionId: session.id })).items[0]!.runIds).toEqual(pending.operation.runIds);
  });

  it('keeps unsaved pixels protected from recovery and retries metadata without inference', async () => {
    failAsset = true;
    await expect(runImageGenerationOperation({ store, sessionId: session.id, plans: [plan({ name: 'red' }), plan({ name: 'blue' })], sources: [], signal: signal(), progress: vi.fn() })).rejects.toThrow('lost asset');
    const operation = (await listImageGenerationOperations({ store, sessionId: session.id })).items[0]!;
    const pending = imagePendingRuns.list()[0]!;
    expect(pending.state.pending).toHaveLength(1);
    await expect(recoverImageGenerationOperation({ store, sessionId: session.id, operationId: operation.id })).rejects.toThrow('unsaved results');
    await imagePendingRuns.retry({ id: pending.id });
    await flushPromises();
    expect(calls).toEqual(['red']);
    expect(await states({ operation })).toEqual(['completed', 'interrupted']);
    await recoverImageGenerationOperation({ store, sessionId: session.id, operationId: operation.id });
    expect(await states({ operation })).toEqual(['completed', 'interrupted']);
  });

  it('blocks a competing execution/recovery lease while native work owns the operation', async () => {
    const operation = await runImageGenerationOperation({
      store,
      sessionId: session.id,
      plans: [plan({
        name: 'red',
        async during() {
          const parent = (await listImageGenerationOperations({ store, sessionId: session.id })).items[0]!;
          await expect(recoverImageGenerationOperation({ store, sessionId: session.id, operationId: parent.id })).rejects.toThrow('active');
          await expect(withImageOperationExecution({ store, operationId: parent.id, execute: async () => {} })).rejects.toThrow('active');
        },
      })],
      sources: [],
      signal: signal(),
      progress: vi.fn(),
    });
    expect(await states({ operation })).toEqual(['completed']);
    await navigator.locks.request(imageOperationSaveLockName({ store, operationId: operation.id }), { ifAvailable: true }, lock => {
      expect(lock).not.toBeNull();
    });
  });

  it('rejects an aborted request before publishing any metadata', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(runImageGenerationOperation({ store, sessionId: session.id, plans: [plan({ name: 'red' })], sources: [], signal: abort.signal, progress: vi.fn() })).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
