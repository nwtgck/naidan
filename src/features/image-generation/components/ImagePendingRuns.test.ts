import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { imagePendingRuns } from '@/features/image-generation/session/pending-runs';
import { toImageGenerationId, toImageGenerationStoreId, toImageGenerationSessionId } from '@/01-models/ids';
import { generationRunFixture } from '@/00-storage/service/image-generation/test-support';
import { finishImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
import ImagePendingRuns from './ImagePendingRuns.vue';
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), download: vi.fn(), url: vi.fn(), revoke: vi.fn() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('@/utils/stream-download', () => ({ downloadBlob: mocks.download }));
beforeEach(async () => {
  vi.clearAllMocks(); mocks.confirm.mockResolvedValue(true); mocks.url.mockReturnValue('blob:pending-image');
  const OriginalURL = URL;
  vi.stubGlobal('URL', class extends OriginalURL {
    static override createObjectURL = mocks.url; static override revokeObjectURL = mocks.revoke;
  });
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  for (const entry of imagePendingRuns.list()) if (entry.phase === 'retired') imagePendingRuns.discard({ id: entry.id });
  vi.unstubAllGlobals();
});
async function pending({ terminal }: { terminal: boolean }) {
  const sessionId = toImageGenerationSessionId({ raw: 'session-aa' });
  const plan = generationRunFixture({ id: 'run-aa', sessionId, count: 1, seed: '42' });
  const create = vi.fn(async () => {}), commit = vi.fn(async () => {}), update = vi.fn(async () => {});
  const owner = imagePendingRuns.create({ store: { storageType: 'opfs', storeId: toImageGenerationStoreId({ raw: 'store-aa' }) }, sessionId, count: 1, sources: [], persistence: { create, commit, update } });
  const snapshot = { id: toImageGenerationId({ raw: 'image-aa' }), createdAt: 1, request: plan.request, inputFiles: [] };
  await owner.submission.accepted({ snapshot, seeds: plan.seeds });
  const output = finishImageGenerationSnapshot({ snapshot, result: { png: new Blob(['image']), width: 256, height: 256, modelVersion: 'model', uniformOutput: false }, previews: [], elapsedMs: 1 });
  if (!terminal) commit.mockRejectedValueOnce(new Error('quota'));
  await owner.submission.output({ index: 0, ...output }).catch(() => {});
  if (terminal) update.mockRejectedValueOnce(new Error('terminal write'));
  await owner.submission.finished({ completion: { type: 'completed' } }).catch(() => {}); await owner.retire();
  return { owner, create, commit, update, output };
}
it('displays and downloads pending pixels after remount, then retries the same save', async () => {
  const value = await pending({ terminal: false }); let wrapper = mount(ImagePendingRuns); await flushPromises();
  expect(wrapper.find('img').exists()).toBe(true);
  await wrapper.get('[data-testid="pending-download"]').trigger('click'); await flushPromises();
  expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({ blob: value.output.files[0]!.blob }));
  wrapper.unmount(); expect(mocks.revoke).toHaveBeenCalledWith('blob:pending-image');
  expect(imagePendingRuns.list()).toHaveLength(1);
  wrapper = mount(ImagePendingRuns); await flushPromises();
  await wrapper.get('[data-testid="pending-retry"]').trigger('click'); await flushPromises();
  expect(value.create).toHaveBeenCalledOnce(); expect(value.commit).toHaveBeenCalledTimes(2);
  expect(wrapper.find('[data-testid="image-pending-runs"]').exists()).toBe(false); wrapper.unmount();
});
it('shows terminal-only save failure and retries metadata without republishing pixels', async () => {
  const value = await pending({ terminal: true }); const wrapper = mount(ImagePendingRuns); await flushPromises();
  expect(wrapper.text()).toContain('Run information'); expect(wrapper.find('[data-testid="pending-download"]').exists()).toBe(false);
  await wrapper.get('[data-testid="pending-retry"]').trigger('click'); await flushPromises();
  expect(value.commit).toHaveBeenCalledOnce(); expect(value.update).toHaveBeenCalledTimes(3); wrapper.unmount();
});
it('requires confirmation to discard without deleting persisted images', async () => {
  const value = await pending({ terminal: false }); const wrapper = mount(ImagePendingRuns); await flushPromises();
  mocks.confirm.mockResolvedValueOnce(false); await wrapper.get('[data-testid="pending-discard"]').trigger('click'); await flushPromises();
  expect(imagePendingRuns.list()).toHaveLength(1);
  await wrapper.get('[data-testid="pending-discard"]').trigger('click'); await flushPromises();
  expect(imagePendingRuns.list()).toEqual([]); expect(value.commit).toHaveBeenCalledOnce(); expect(value.owner.snapshot().pending).toEqual([]); wrapper.unmount();
});
