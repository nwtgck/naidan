import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { pendingImageHistory } from '@/features/image-generation/history/pending-saves';
import { snapshotImageGeneration, finishImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import ImagePendingHistory from './ImagePendingHistory.vue';
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), download: vi.fn(), url: vi.fn(), revoke: vi.fn() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('@/utils/stream-download', () => ({ downloadBlob: mocks.download }));
beforeEach(async () => {
  vi.clearAllMocks(); mocks.confirm.mockResolvedValue(true); mocks.url.mockReturnValue('blob:pending');
  const OriginalURL = URL;
  vi.stubGlobal('URL', class extends OriginalURL {
    static override createObjectURL = mocks.url; static override revokeObjectURL = mocks.revoke;
  });
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  for (const entry of pendingImageHistory.list()) pendingImageHistory.discard({ id: entry.record.id });
  vi.unstubAllGlobals();
});
async function pending() {
  const snapshot = snapshotImageGeneration({
    request: requestFixture(),
    sourceCommit: 'a'.repeat(40),
    createdAt: 1,
    locateFile: ({ file }) => ({ type: 'file', name: file.name, size: file.size, lastModified: file.lastModified }),
  });
  const output = finishImageGenerationSnapshot({ snapshot, result: { png: new Blob(['image']), width: 256, height: 256, modelVersion: 'model', uniformOutput: false }, previews: [], elapsedMs: 1 });
  const save = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined);
  const id = pendingImageHistory.retain({ ...output, save });
  await expect(pendingImageHistory.retry({ id })).rejects.toThrow('quota');
  return { id, output, save };
}
it('remounts, previews and downloads retained pixels, then retries the same save', async () => {
  const value = await pending(); let wrapper = mount(ImagePendingHistory); await flushPromises();
  expect(wrapper.find('img').exists()).toBe(true);
  await wrapper.get('[data-testid="pending-history-download"]').trigger('click'); await flushPromises();
  expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({ blob: value.output.files[0]!.blob }));
  wrapper.unmount(); expect(mocks.revoke).toHaveBeenCalledWith('blob:pending'); expect(pendingImageHistory.list()).toHaveLength(1);
  wrapper = mount(ImagePendingHistory); await flushPromises();
  await wrapper.get('[data-testid="pending-history-retry"]').trigger('click'); await flushPromises();
  expect(value.save).toHaveBeenCalledTimes(2); expect(value.save.mock.calls[1]![0]).toBe(value.save.mock.calls[0]![0]);
  expect(wrapper.find('[data-testid="image-pending-history"]').exists()).toBe(false); wrapper.unmount();
});
it('requires confirmation, disables mutation during saving and invalidates discarded retry handles', async () => {
  const value = await pending(); const wrapper = mount(ImagePendingHistory); await flushPromises();
  const gate = Promise.withResolvers<void>(); value.save.mockReturnValueOnce(gate.promise);
  const saving = pendingImageHistory.retry({ id: value.id }); await flushPromises();
  expect(wrapper.get('[data-testid="pending-history-retry"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="pending-history-discard"]').attributes('disabled')).toBeDefined();
  const failed = expect(saving).rejects.toThrow('full'); gate.reject(new Error('full')); await failed; await flushPromises();
  mocks.confirm.mockResolvedValueOnce(false); await wrapper.get('[data-testid="pending-history-discard"]').trigger('click'); await flushPromises();
  expect(pendingImageHistory.list()).toHaveLength(1);
  await wrapper.get('[data-testid="pending-history-discard"]').trigger('click'); await flushPromises();
  expect(pendingImageHistory.list()).toEqual([]); await expect(pendingImageHistory.retry({ id: value.id })).rejects.toThrow('discarded'); wrapper.unmount();
});
