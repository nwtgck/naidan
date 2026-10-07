import { expect, it, vi } from 'vitest';
import { toImageGenerationId, toImageGenerationSessionId, toImageGenerationStoreId } from '@/01-models/ids';
import { generationRunFixture } from '@/00-storage/service/image-generation/test-support';
import { finishImageGenerationSnapshot, type ImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
import { createImagePendingRuns } from './pending-runs';
import type { ImageGenerationRunPersistence } from './run-sink';

function harness() {
  const sessionId = toImageGenerationSessionId({ raw: 'session-aa' });
  const plan = generationRunFixture({ id: 'run-aa', sessionId, count: 1, seed: '42' });
  const snapshot: ImageGenerationSnapshot = { id: toImageGenerationId({ raw: 'image-aa' }), createdAt: 1, request: plan.request, inputFiles: [] };
  const persistence = {
    create: vi.fn<ImageGenerationRunPersistence['create']>().mockResolvedValue(undefined),
    commit: vi.fn<ImageGenerationRunPersistence['commit']>().mockResolvedValue(undefined),
    update: vi.fn<ImageGenerationRunPersistence['update']>().mockResolvedValue(undefined),
  };
  const store = { storageType: 'opfs' as const, storeId: toImageGenerationStoreId({ raw: 'store-aa' }) };
  const registry = createImagePendingRuns({ maxRuns: 2, byteLimit: 1024 });
  const create = () => registry.create({ store, sessionId, count: 1, sources: [], persistence });
  const owner = create();
  const output = finishImageGenerationSnapshot({
    snapshot,
    result: { png: new Blob(['pixels']), width: 256, height: 256, modelVersion: 'version', uniformOutput: false },
    previews: [],
    elapsedMs: 2,
  });
  return { registry, owner, create, snapshot, output, plan, persistence, store };
}
it('keeps confirmed pixels and original identities after the view unsubscribes', async () => {
  const h = harness(), view = vi.fn(); const unsubscribe = h.registry.subscribe({ listener: view });
  await h.owner.submission.accepted({ snapshot: h.snapshot, seeds: h.plan.seeds });
  h.persistence.commit.mockRejectedValueOnce(new Error('quota'));
  await expect(h.owner.submission.output({ index: 0, ...h.output })).rejects.toThrow('quota');
  await h.owner.submission.finished({ completion: { type: 'failed', message: 'quota' } });
  await h.owner.retire(); unsubscribe(); view.mockClear();
  expect(h.registry.list()[0]?.state.pending[0]?.files[0]?.blob).toBe(h.output.files[0]?.blob);
  const attempted = h.persistence.commit.mock.calls[0]![0];
  await h.registry.retry({ id: h.owner.id });
  expect(h.persistence.commit.mock.calls[1]![0]).toBe(attempted);
  expect(h.persistence.create).toHaveBeenCalledOnce(); expect(view).not.toHaveBeenCalled(); expect(h.registry.list()).toEqual([]);
});
it('retains a failed terminal acknowledgement even when no pixels remain pending', async () => {
  const h = harness(); await h.owner.submission.accepted({ snapshot: h.snapshot, seeds: h.plan.seeds });
  await h.owner.submission.output({ index: 0, ...h.output });
  h.persistence.update.mockRejectedValueOnce(new Error('terminal write'));
  await expect(h.owner.submission.finished({ completion: { type: 'completed' } })).rejects.toThrow('terminal write');
  await h.owner.retire(); expect(h.registry.list()[0]?.state).toMatchObject({ pending: [], needsRetry: true });
  const attempted = h.persistence.update.mock.calls[1]![0]; await h.registry.retry({ id: h.owner.id });
  expect(h.persistence.update.mock.calls[2]![0]).toEqual(attempted); expect(h.registry.list()).toEqual([]);
});
it('does not discard or retry a live producer and never evicts another run at capacity', async () => {
  const h = harness(); const other = h.create();
  expect(() => h.registry.discard({ id: h.owner.id })).toThrow('finish');
  await expect(h.registry.retry({ id: h.owner.id })).rejects.toThrow('finish');
  expect(h.create).toThrow('Save or discard');
  await other.retire(); expect(h.registry.list()).toHaveLength(1);
  await h.owner.retire(); expect(h.registry.list()).toEqual([]);
});
it('a persistence observer exception cannot reclassify a successful storage operation', async () => {
  const h = harness(); h.registry.subscribe({
    listener: () => {
      throw new Error('detached render');
    },
  });
  await h.owner.submission.accepted({ snapshot: h.snapshot, seeds: h.plan.seeds });
  await h.owner.submission.output({ index: 0, ...h.output });
  await h.owner.submission.finished({ completion: { type: 'completed' } }); await h.owner.retire();
  expect(h.registry.list()).toEqual([]); expect(h.persistence.commit).toHaveBeenCalledOnce();
});
it('retirement without a terminal notification marks a partial run as failed', async () => {
  const h = harness(); await h.owner.submission.accepted({ snapshot: h.snapshot, seeds: h.plan.seeds });
  await h.owner.retire();
  expect(h.persistence.update).toHaveBeenLastCalledWith(expect.objectContaining({ execution: expect.objectContaining({ type: 'failed' }) }));
  expect(h.registry.list()).toEqual([]);
});
it('repeated failed retries retain the same record until explicit discard', async () => {
  const h = harness(); h.persistence.create.mockRejectedValue(new Error('deleted store'));
  await expect(h.owner.submission.accepted({ snapshot: h.snapshot, seeds: h.plan.seeds })).rejects.toThrow();
  await h.owner.submission.finished({ completion: { type: 'failed', message: 'deleted store' } }); await h.owner.retire();
  const before = h.registry.list()[0]!.state.run;
  await expect(h.registry.retry({ id: h.owner.id })).rejects.toThrow('deleted store');
  expect(h.registry.list()[0]?.state.run).toBe(before);
  h.registry.discard({ id: h.owner.id }); expect(h.registry.list()).toEqual([]);
});
it('keeps the original storage address despite later mutation of the caller object', () => {
  const h = harness(); h.store.storeId = toImageGenerationStoreId({ raw: 'other-store' }); expect(h.registry.list()[0]?.store.storeId).toBe('store-aa');
});
it('does not leave a raw retry closure able to save a discarded run', async () => {
  const h = harness(); await h.owner.submission.accepted({ snapshot: h.snapshot, seeds: h.plan.seeds });
  h.persistence.commit.mockRejectedValueOnce(new Error('quota'));
  await expect(h.owner.submission.output({ index: 0, ...h.output })).rejects.toThrow();
  const retry = h.owner.submission.retry!;
  await h.owner.submission.finished({ completion: { type: 'failed', message: 'quota' } }); await h.owner.retire();
  h.registry.discard({ id: h.owner.id });
  await expect(retry()).rejects.toThrow('saved or discarded'); expect(h.persistence.commit).toHaveBeenCalledOnce();
});
it('a save in progress cannot be discarded and a second retry cannot duplicate publication', async () => {
  const h = harness(); await h.owner.submission.accepted({ snapshot: h.snapshot, seeds: h.plan.seeds });
  h.persistence.commit.mockRejectedValueOnce(new Error('quota'));
  await expect(h.owner.submission.output({ index: 0, ...h.output })).rejects.toThrow();
  await h.owner.submission.finished({ completion: { type: 'failed', message: 'quota' } }); await h.owner.retire();
  const gate = Promise.withResolvers<void>(); h.persistence.commit.mockReturnValueOnce(gate.promise);
  const retry = h.registry.retry({ id: h.owner.id });
  expect(() => h.registry.discard({ id: h.owner.id })).toThrow('finish');
  await expect(h.registry.retry({ id: h.owner.id })).rejects.toThrow('finish');
  gate.resolve(); await retry; expect(h.persistence.commit).toHaveBeenCalledTimes(2);
});
