import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import ChatMediaShelf from './ChatMediaShelf.vue';
import BinaryObjectPreviewModal from './BinaryObjectPreviewModal.vue';
import MessageItem from './MessageItem.vue';
import { ImageDownloadHydrator } from './ImageDownloadHydrator';
import { useImagePreview } from '@/composables/useImagePreview';
import type { BinaryObjectPreviewItem } from '@/composables/useImagePreview';
import { useBinaryActions } from '@/composables/useBinaryActions';
import { storageService } from '@/00-storage/service';
import { toAttachmentId, toBinaryObjectId, toChatId, toMessageId } from '@/01-models/ids';
import type { UserMessageNode } from '@/01-models/types';
import { ensureAllStringsForTest } from '@/strings/test-utils';

vi.mock('@/00-storage/service', () => ({ storageService: {
  getFile: vi.fn(), getBinaryObject: vi.fn(), deleteBinaryObject: vi.fn(), subscribeToChanges: vi.fn(() => () => {}),
} }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: vi.fn() }) }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn() }) }));
const wrappers: ReturnType<typeof mount>[] = [];
const chatId = toChatId({ raw: 'media-chat' });
let downloads: { url: string; name: string; blob: Blob }[];
let urls: Map<string, Blob>;
function png() {
  return new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a14sAAAAASUVORK5CYII='), character => character.charCodeAt(0))], { type: 'image/png' });
}
function message({ blob }: { blob: Blob | undefined }): UserMessageNode {
  const base = { id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'binary' }),
    originalName: 'local.png', mimeType: 'image/png', size: 68, uploadedAt: 0 };
  return { id: toMessageId({ raw: 'u' }), role: 'user', createdAt: 0, modelId: undefined, lmParameters: undefined,
    parts: [
      { id: 'p', type: 'text', text: 'A local image', completeness: 'complete' },
      { id: 'a', type: 'attachment', attachment: blob === undefined ? { ...base, status: 'persisted' } : { ...base, status: 'memory', blob } },
    ], replies: { items: [] } };
}
function mountOwner({ messages, showMessage }: { messages: UserMessageNode[]; showMessage: boolean }) {
  const nodes = ref(messages);
  let preview!: ReturnType<typeof useImagePreview>;
  const Owner = defineComponent({
    setup() {
      preview = useImagePreview({ scoped: true });
      const { downloadBinaryObject } = useBinaryActions();
      return () => h('div', [
        showMessage && nodes.value[0] ? h(MessageItem, { chatId, message: nodes.value[0] }) : h(ChatMediaShelf, { chatId, messages: nodes.value }),
        preview.state.value ? h(BinaryObjectPreviewModal, {
          objects: preview.state.value.objects, initialId: preview.state.value.initialId,
          onClose: preview.closePreview,
          onDownload: (obj: BinaryObjectPreviewItem) => downloadBinaryObject({ obj, memoryBlob: obj.memoryBlob }),
        }) : undefined,
      ]);
    },
  });
  const wrapper = mount(Owner, { global: { stubs: { Teleport: true } } }); wrappers.push(wrapper);
  return { wrapper, nodes, preview };
}
async function readBytes({ blob }: { blob: Blob }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = reject; reader.readAsArrayBuffer(blob);
  });
}
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.clearAllMocks(); downloads = []; urls = new Map();
  vi.mocked(storageService.getFile).mockResolvedValue(null);
  vi.mocked(storageService.getBinaryObject).mockResolvedValue(null);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    if (!(blob instanceof Blob)) throw new Error('Expected a Blob.');
    const url = `blob:memory-${urls.size + 1}`; urls.set(url, blob); return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const blob = urls.get(this.href);
    if (!blob) throw new Error('Download did not refer to an owned Blob.');
    downloads.push({ url: this.href, name: this.download, blob });
  });
  vi.stubGlobal('IntersectionObserver', class {
    observe() {} disconnect() {}
  });
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it('opens and downloads an unsaved attachment through the real shelf, preview state, modal and action', async () => {
  const blob = png(); const original = message({ blob }); const { wrapper, preview } = mountOwner({ messages: [original], showMessage: false });
  await flushPromises(); await wrapper.get('[data-testid="media-preview-trigger"]').trigger('click'); await flushPromises();
  const modal = wrapper.getComponent(BinaryObjectPreviewModal);
  expect(modal.get('[data-testid="preview-image"]').attributes('src')).toBe('blob:memory-1');
  expect(preview.state.value?.objects[0]?.memoryBlob).toBe(blob);
  expect(storageService.getFile).not.toHaveBeenCalled(); expect(storageService.getBinaryObject).not.toHaveBeenCalled();
  expect(modal.get('[data-testid="preview-delete-btn"]').attributes()).toHaveProperty('disabled');
  await modal.get('[data-testid="preview-delete-btn"]').trigger('click'); expect(modal.emitted('delete')).toBeUndefined();
  await modal.get('[data-testid="preview-download-btn"]').trigger('click'); await flushPromises();
  expect(downloads).toHaveLength(1); expect(downloads[0]?.blob).toBe(blob); expect(downloads[0]?.name).toBe('local.png');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(downloads[0]?.url);
  expect(original.parts[1]).toMatchObject({ attachment: { status: 'memory', blob } });
  await modal.get('[data-testid="preview-close-btn"]').trigger('click'); await flushPromises();
  expect(preview.state.value).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:memory-1');
});
it('downloads the original unsaved Blob from the shelf without a storage read', async () => {
  const blob = png(); const { wrapper } = mountOwner({ messages: [message({ blob })], showMessage: false });
  await flushPromises(); await wrapper.get('[data-testid="download-gen-image-button"]').trigger('click'); await flushPromises();
  expect(downloads).toHaveLength(1); expect(downloads[0]?.blob).toBe(blob); expect(downloads[0]?.name).toBe('local.png');
  expect(storageService.getFile).not.toHaveBeenCalled(); expect(storageService.getBinaryObject).not.toHaveBeenCalled();
});
it('downloads a metadata-enabled local copy without inventing a generation prompt for an attachment', async () => {
  const blob = png(); const before = await readBytes({ blob }); const { wrapper } = mountOwner({ messages: [message({ blob })], showMessage: false });
  await flushPromises(); await wrapper.get('[data-testid="download-gen-image-dropdown-toggle"]').trigger('click');
  await wrapper.get('[data-testid="download-with-metadata-option"]').trigger('click');
  await vi.waitFor(() => expect(downloads).toHaveLength(1));
  const download = downloads[0]; if (!download) throw new Error('Missing download.');
  expect(download.name).toMatch(/\.png$/); expect(download.blob).not.toBe(blob);
  expect(await readBytes({ blob: download.blob })).toEqual(before);
  expect(await readBytes({ blob })).toEqual(before);
  expect(storageService.getFile).not.toHaveBeenCalled(); expect(storageService.getBinaryObject).not.toHaveBeenCalled();
});
it('reads persisted media from storage and does not disable its delete action', async () => {
  const blob = png(); vi.mocked(storageService.getFile).mockResolvedValue(blob);
  const { wrapper } = mountOwner({ messages: [message({ blob: undefined })], showMessage: false });
  await flushPromises(); await wrapper.get('[data-testid="media-preview-trigger"]').trigger('click'); await flushPromises();
  const modal = wrapper.getComponent(BinaryObjectPreviewModal);
  expect(storageService.getFile).toHaveBeenCalledWith({ binaryObjectId: toBinaryObjectId({ raw: 'binary' }) });
  expect(modal.get('[data-testid="preview-delete-btn"]').attributes('disabled')).toBeUndefined();
  await modal.get('[data-testid="preview-download-btn"]').trigger('click'); await flushPromises();
  expect(downloads[0]?.blob).toBe(blob);
});
it('opens an unsaved image directly from its message without asking storage for metadata', async () => {
  const blob = png(); const { wrapper } = mountOwner({ messages: [message({ blob })], showMessage: true });
  await flushPromises();
  await vi.waitFor(() => expect(wrapper.find('[data-testid="message-attachment-image"]').exists()).toBe(true));
  await wrapper.get('[data-testid="message-attachment-image"]').trigger('click'); await flushPromises();
  expect(wrapper.getComponent(BinaryObjectPreviewModal).get('[data-testid="preview-filename"]').text()).toBe('local.png');
  expect(storageService.getFile).not.toHaveBeenCalled(); expect(storageService.getBinaryObject).not.toHaveBeenCalled();
});
it('snapshots preview metadata while keeping the exact local Blob reference', async () => {
  const { preview } = mountOwner({ messages: [], showMessage: false });
  const blob = png(); const item: BinaryObjectPreviewItem = { id: toBinaryObjectId({ raw: 'copy' }), name: 'original.png', size: blob.size, mimeType: blob.type, createdAt: 0, memoryBlob: blob };
  const items = [item]; preview.openPreview({ objects: items, initialId: item.id });
  item.name = 'edited.png'; items.length = 0;
  expect(preview.state.value?.objects).toHaveLength(1); expect(preview.state.value?.objects[0]?.name).toBe('original.png');
  expect(preview.state.value?.objects[0]?.memoryBlob).toBe(blob);
});

it('uses the supplied filename and local bytes when embedding explicit metadata', async () => {
  const blob = png(); const before = await readBytes({ blob });
  await ImageDownloadHydrator.download({
    id: toBinaryObjectId({ raw: 'not-persisted' }), name: 'local.PNG', memoryBlob: blob,
    prompt: '山の風景', steps: 4, seed: 12, model: 'model', withMetadata: true,
    storageService, onError: () => {
      throw new Error('Embedding failed.');
    },
  });
  expect(downloads).toHaveLength(1);
  const download = downloads[0]; if (!download) throw new Error('Missing metadata download.');
  expect(download.name).toMatch(/\.PNG$/);
  expect(new TextDecoder().decode(await readBytes({ blob: download.blob }))).toContain('山の風景');
  expect(await readBytes({ blob })).toEqual(before);
  expect(storageService.getFile).not.toHaveBeenCalled(); expect(storageService.getBinaryObject).not.toHaveBeenCalled();
});
