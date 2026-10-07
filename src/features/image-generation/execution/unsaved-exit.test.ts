// @vitest-environment happy-dom
import { expect, it, onTestFinished, vi } from 'vitest';
import { toImageGenerationId, toImageGenerationSessionId, toImageGenerationStoreId } from '@/01-models/ids';
import { generationRunFixture } from '@/00-storage/service/image-generation/test-support';
import { finishImageGenerationSnapshot, recoverImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
import { imageRecoveryStore } from './recovery';
import { pendingImageHistory } from '@/features/image-generation/history/pending-saves';
import { imagePendingRuns } from '@/features/image-generation/session/pending-runs';
import type { ImageGenerationRunPersistence } from '@/features/image-generation/session/run-sink';

function publication() {
  const sessionId = toImageGenerationSessionId({ raw: 'unsaved-exit-session' });
  const plan = generationRunFixture({ id: 'unsaved-exit-run', sessionId, count: 1, seed: '42' });
  const snapshot = { id: toImageGenerationId({ raw: 'unsaved-exit-image' }), createdAt: 1, request: plan.request, inputFiles: [] };
  const output = finishImageGenerationSnapshot({
    snapshot,
    previews: [],
    elapsedMs: 1,
    result: { png: new Blob(['pixels']), width: 256, height: 256, modelVersion: 'test', uniformOutput: false },
  });
  return { plan, sessionId, snapshot, output };
}
function allowsReload(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return !event.defaultPrevented;
}

it('retains recovery pixels after a view detaches without a browser reload warning', () => {
  const { snapshot } = publication();
  const recovered = recoverImageGenerationSnapshot({
    snapshot,
    elapsedMs: 1,
    output: { png: new Blob(['pixels']), width: 256, height: 256, reported: undefined },
  });
  const unsubscribe = imageRecoveryStore.subscribe({ listener: vi.fn() });
  const reservation = imageRecoveryStore.reserve({ bytes: 6 }); unsubscribe();
  const id = reservation.retain({ ...recovered, retry: undefined });
  onTestFinished(() => imageRecoveryStore.remove({ id }));
  expect(allowsReload()).toBe(true);
  expect(imageRecoveryStore.list().find(entry => entry.id === id)?.files[0]?.blob).toBe(recovered.files[0]?.blob);
  imageRecoveryStore.remove({ id }); expect(allowsReload()).toBe(true);
});

it('keeps retryable pending history and its immutable pixels without blocking reload', async () => {
  const { output } = publication(), save = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined);
  const id = pendingImageHistory.retain({ ...output, save });
  onTestFinished(() => pendingImageHistory.discard({ id }));
  expect(allowsReload()).toBe(true);
  await expect(pendingImageHistory.retry({ id })).rejects.toThrow('quota');
  expect(allowsReload()).toBe(true);
  expect(pendingImageHistory.list().find(entry => entry.record.id === id)?.files[0]?.blob).toBe(output.files[0]?.blob);
  await pendingImageHistory.retry({ id }); expect(save).toHaveBeenCalledTimes(2);
  expect(allowsReload()).toBe(true);
});

it('allows reload during a run and after a failed output save while preserving retry ownership', async () => {
  const { plan, snapshot, sessionId, output } = publication();
  const persistence = {
    create: vi.fn<ImageGenerationRunPersistence['create']>().mockResolvedValue(undefined),
    commit: vi.fn<ImageGenerationRunPersistence['commit']>().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined),
    update: vi.fn<ImageGenerationRunPersistence['update']>().mockResolvedValue(undefined),
  };
  const run = imagePendingRuns.create({
    store: { storageType: 'opfs', storeId: toImageGenerationStoreId({ raw: 'unsaved-exit-store' }) },
    sessionId,
    count: 1,
    sources: [],
    persistence,
  });
  onTestFinished(async () => {
    await run.retire(); imagePendingRuns.discard({ id: run.id });
  });
  expect(allowsReload()).toBe(true);
  await run.submission.accepted({ snapshot, seeds: plan.seeds });
  await expect(run.submission.output({ index: 0, ...output })).rejects.toThrow('quota');
  await run.submission.finished({ completion: { type: 'failed', message: 'quota' } }); await run.retire();
  expect(allowsReload()).toBe(true);
  expect(imagePendingRuns.list().find(entry => entry.id === run.id)?.state.pending[0]?.files[0]?.blob).toBe(output.files[0]?.blob);
  await imagePendingRuns.retry({ id: run.id }); expect(persistence.commit).toHaveBeenCalledTimes(2);
  expect(allowsReload()).toBe(true);
});
