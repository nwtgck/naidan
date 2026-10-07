import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { imagePendingRuns } from '@/features/image-generation/session/pending-runs';
import { imageRecoveryStore } from '@/features/image-generation/execution/recovery';
import { toImageGenerationId, toImageGenerationStoreId, toImageGenerationSessionId } from '@/01-models/ids';
import { generationRunFixture } from '@/00-storage/service/image-generation/test-support';
import { recoverImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
import ImageRecoveredOutputs from './ImageRecoveredOutputs.vue';
import ImagePendingRuns from './ImagePendingRuns.vue';
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), url: vi.fn(), revoke: vi.fn() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
beforeEach(async () => {
  vi.clearAllMocks(); mocks.confirm.mockResolvedValue(true); mocks.url.mockReturnValue('blob:recovered-image');
  const OriginalURL = URL;
  vi.stubGlobal('URL', class extends OriginalURL {
    static override createObjectURL = mocks.url; static override revokeObjectURL = mocks.revoke;
  });
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  for (const entry of imagePendingRuns.list()) if (entry.phase === 'retired') imagePendingRuns.discard({ id: entry.id });
  for (const entry of imageRecoveryStore.list()) imageRecoveryStore.remove({ id: entry.id });
  vi.unstubAllGlobals();
});
async function recovered() {
  const sessionId = toImageGenerationSessionId({ raw: 'session-aa' });
  const plan = generationRunFixture({ id: 'run-aa', sessionId, count: 1, seed: '42' });
  const commit = vi.fn(async () => {}).mockRejectedValueOnce(new Error('quota'));
  const owner = imagePendingRuns.create({
    store: { storageType: 'opfs', storeId: toImageGenerationStoreId({ raw: 'store-aa' }) },
    sessionId,
    count: 1,
    sources: [],
    persistence: { create: vi.fn(async () => {}), commit, update: vi.fn(async () => {}) },
  });
  const snapshot = { id: toImageGenerationId({ raw: 'image-aa' }), createdAt: 1, request: plan.request, inputFiles: [] };
  await owner.submission.accepted({ snapshot, seeds: plan.seeds });
  const output = recoverImageGenerationSnapshot({ snapshot, output: { png: new Blob(['pixels']), width: 256, height: 256, reported: undefined }, elapsedMs: 1 });
  const id = imageRecoveryStore.reserve({ bytes: 64 }).retain({ ...output, retry: owner.submission.retry });
  await owner.submission.recovered!({
    index: 0,
    ...output,
    onPersisted: () => imageRecoveryStore.remove({ id }),
    onDiscarded: () => imageRecoveryStore.remove({ id }),
  }).catch(() => {});
  await owner.submission.finished({ completion: { type: 'interrupted' } }); await owner.retire();
  return { owner, commit };
}
it('shows run-owned recovery only in the pending-run panel and discards it through the run controls', async () => {
  const value = await recovered();
  const recoveredPanel = mount(ImageRecoveredOutputs), wrapper = mount(ImagePendingRuns);
  await flushPromises(); expect(wrapper.find('img').exists()).toBe(true);
  expect(recoveredPanel.find('[data-testid="image-recovered-outputs"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="pending-unconfirmed"]').text()).toContain('unconfirmed');
  await wrapper.get('[data-testid="pending-discard"]').trigger('click'); await flushPromises();
  expect(imagePendingRuns.list()).toEqual([]); expect(imageRecoveryStore.list()).toEqual([]);
  await expect(value.owner.submission.retry!()).rejects.toThrow('discarded'); expect(value.commit).toHaveBeenCalledOnce();
  wrapper.unmount(); recoveredPanel.unmount(); expect(mocks.revoke).toHaveBeenCalledWith('blob:recovered-image');
});
async function looseImage() {
  const sessionId = toImageGenerationSessionId({ raw: 'session-loose' });
  const plan = generationRunFixture({ id: 'run-loose', sessionId, count: 1, seed: '42' });
  const snapshot = { id: toImageGenerationId({ raw: 'image-loose' }), createdAt: 1, request: plan.request, inputFiles: [] };
  const output = recoverImageGenerationSnapshot({ snapshot, output: { png: new Blob(['loose-pixels']), width: 256, height: 256, reported: undefined }, elapsedMs: 1 });
  const id = imageRecoveryStore.reserve({ bytes: 128 }).retain({ ...output, retry: undefined });
  return { id, output, snapshot, plan, sessionId };
}
it('discards an unowned image without discarding another pending run', async () => {
  await recovered(); const loose = await looseImage();
  const wrapper = mount(ImageRecoveredOutputs); await flushPromises();
  expect(wrapper.findAll('[data-testid="recovered-discard"]')).toHaveLength(1);
  await wrapper.get('[data-testid="recovered-discard"]').trigger('click'); await flushPromises();
  expect(imageRecoveryStore.list().some(entry => entry.id === loose.id)).toBe(false);
  expect(imageRecoveryStore.list()).toHaveLength(1); expect(imagePendingRuns.list()).toHaveLength(1);
  wrapper.unmount();
});
it('does not reuse a single-image confirmation after a run claims that image', async () => {
  const loose = await looseImage(), confirmation = Promise.withResolvers<boolean>();
  mocks.confirm.mockReturnValueOnce(confirmation.promise);
  const wrapper = mount(ImageRecoveredOutputs); await flushPromises();
  await wrapper.get('[data-testid="recovered-discard"]').trigger('click');
  const owner = imagePendingRuns.create({
    store: { storageType: 'opfs', storeId: toImageGenerationStoreId({ raw: 'store-loose' }) },
    sessionId: loose.sessionId,
    count: 1,
    sources: [],
    persistence: {
      create: vi.fn(async () => {}),
      commit: vi.fn(async () => {
      throw new Error('quota');
    }),
      update: vi.fn(async () => {}),
    },
  });
  await owner.submission.accepted({ snapshot: loose.snapshot, seeds: loose.plan.seeds });
  await owner.submission.recovered!({ index: 0, ...loose.output, onPersisted: () => imageRecoveryStore.remove({ id: loose.id }), onDiscarded: () => imageRecoveryStore.remove({ id: loose.id }) }).catch(() => {});
  await owner.submission.finished({ completion: { type: 'interrupted' } }); await owner.retire();
  confirmation.resolve(true); await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('unsaved run');
  expect(imageRecoveryStore.list()).toHaveLength(1); expect(imagePendingRuns.list()).toHaveLength(1);
  wrapper.unmount();
});
it('closing a recovery preview releases its URL but neither the pixels nor their retry owner', async () => {
  await recovered(); await looseImage(); const wrapper = mount(ImageRecoveredOutputs); await flushPromises(); wrapper.unmount();
  expect(mocks.revoke).toHaveBeenCalledWith('blob:recovered-image'); expect(imageRecoveryStore.list()).toHaveLength(2); expect(imagePendingRuns.list()).toHaveLength(1);
});
