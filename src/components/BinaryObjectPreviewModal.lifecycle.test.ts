import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import BinaryObjectPreviewModal from './BinaryObjectPreviewModal.vue';
import { storageService } from '@/00-storage/service';
import { toBinaryObjectId } from '@/01-models/ids';
import type { BinaryObjectPreviewItem } from '@/composables/useImagePreview';
import { ensureAllStringsForTest } from '@/strings/test-utils';

vi.mock('@/00-storage/service', () => ({ storageService: { getFile: vi.fn() } }));
const wrappers: ReturnType<typeof mount>[] = [];
function pendingBlob() {
  let resolve!: (value: Blob | null) => void;
  const promise = new Promise<Blob | null>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
function object({ id, name }: { id: string; name: string }): BinaryObjectPreviewItem {
  return { id: toBinaryObjectId({ raw: id }), name, mimeType: 'image/png', size: 3, createdAt: 0, memoryBlob: undefined };
}
const a = object({ id: 'a', name: 'a.png' });
const b = object({ id: 'b', name: 'b.png' });
function modal({ objects }: { objects: BinaryObjectPreviewItem[] }) {
  const wrapper = mount(BinaryObjectPreviewModal, { props: { objects, initialId: a.id }, global: { stubs: { Teleport: true } } });
  wrappers.push(wrapper);
  return wrapper;
}
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.useFakeTimers();
  vi.mocked(storageService.getFile).mockReset();
  let sequence = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${++sequence}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});
it('does not create an object URL for a read completed after unmount', async () => {
  const reading = pendingBlob(); vi.mocked(storageService.getFile).mockReturnValue(reading.promise);
  const wrapper = modal({ objects: [a] }); wrapper.unmount();
  reading.resolve(new Blob(['old'])); await flushPromises();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('releases the old preview when the next file is missing', async () => {
  vi.mocked(storageService.getFile).mockResolvedValueOnce(new Blob(['a'])).mockResolvedValueOnce(null);
  const wrapper = modal({ objects: [a, b] }); await flushPromises();
  await wrapper.get('[data-testid="preview-next-btn"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-testid="preview-filename"]').text()).toBe('b.png');
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview-1');
});
it('ignores an earlier read of the same ID after its descriptor is replaced', async () => {
  const first = pendingBlob(); const second = pendingBlob();
  vi.mocked(storageService.getFile).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const wrapper = modal({ objects: [a] });
  await wrapper.setProps({ objects: [{ ...a, name: 'new.png' }] });
  const newBlob = new Blob(['new']); second.resolve(newBlob); await flushPromises();
  first.resolve(new Blob(['old'])); await flushPromises();
  expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(newBlob);
  expect(wrapper.get('[data-testid="preview-filename"]').text()).toBe('new.png');
});
it('ignores the first read when navigation returns to the same ID', async () => {
  const first = pendingBlob(); const middle = pendingBlob(); const last = pendingBlob();
  vi.mocked(storageService.getFile).mockReturnValueOnce(first.promise).mockReturnValueOnce(middle.promise).mockReturnValueOnce(last.promise);
  const wrapper = modal({ objects: [a, b] });
  await wrapper.get('[data-testid="preview-next-btn"]').trigger('click');
  await wrapper.get('[data-testid="preview-prev-btn"]').trigger('click');
  const latest = new Blob(['latest']); last.resolve(latest); await flushPromises();
  first.resolve(new Blob(['stale'])); middle.resolve(new Blob(['b'])); await flushPromises();
  expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(latest);
});
it('uses a newly supplied initial ID without remounting the modal', async () => {
  vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['image']));
  const wrapper = modal({ objects: [a, b] }); await flushPromises();
  await wrapper.setProps({ initialId: b.id }); await flushPromises();
  expect(wrapper.get('[data-testid="preview-filename"]').text()).toBe('b.png');
  expect(storageService.getFile).toHaveBeenLastCalledWith({ binaryObjectId: b.id });
});
it('keeps the selected ID when the media list is reordered', async () => {
  vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['image']));
  const wrapper = modal({ objects: [a, b] }); await flushPromises();
  await wrapper.get('[data-testid="preview-next-btn"]').trigger('click'); await flushPromises();
  await wrapper.setProps({ objects: [b, a] }); await flushPromises();
  expect(wrapper.get('[data-testid="preview-filename"]').text()).toBe('b.png');
});
it('releases the current URL when the selected object is removed', async () => {
  vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['image']));
  const wrapper = modal({ objects: [a] }); await flushPromises();
  await wrapper.setProps({ objects: [] }); await flushPromises();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview-1');
});
it('does not leave a loading timer when the selected object disappears during a read', async () => {
  const reading = pendingBlob(); vi.mocked(storageService.getFile).mockReturnValue(reading.promise);
  const wrapper = modal({ objects: [a] });
  await wrapper.setProps({ objects: [] });
  wrapper.unmount(); reading.resolve(null); await flushPromises();
  expect(vi.getTimerCount()).toBe(0);
});

it('navigates past repeated references to the same binary object', async () => {
  vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['image']));
  const wrapper = modal({ objects: [a, a, b] }); await flushPromises();
  await wrapper.get('[data-testid="preview-next-btn"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-testid="preview-index-info"]').text()).toMatch(/^2\s*\/\s*3$/);
  await wrapper.get('[data-testid="preview-next-btn"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-testid="preview-filename"]').text()).toBe('b.png');
});
it('uses the new initial ID when both the list and initial selection change together', async () => {
  vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['image']));
  const wrapper = modal({ objects: [a, b] }); await flushPromises();
  await wrapper.setProps({ objects: [{ ...b }, { ...a }], initialId: b.id }); await flushPromises();
  expect(wrapper.get('[data-testid="preview-filename"]').text()).toBe('b.png');
  expect(wrapper.get('[data-testid="preview-index-info"]').text()).toMatch(/^1\s*\/\s*2$/);
});
