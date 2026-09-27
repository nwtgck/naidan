import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref, shallowRef } from 'vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { toBinaryObjectId, toImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import type { ImageGenerationHistoryView } from '@/features/stable-diffusion-cpp-browser/history-view';
import { createImageForm } from '@/features/stable-diffusion-cpp-browser/form';
import ImageGenerationHistory from './ImageGenerationHistory.vue';
import ImageHistoryImage from './ImageHistoryImage.vue';
const onDownload = vi.fn(async () => ({ status: 'downloaded' as const }));
let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:history-image'), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; onDownload.mockClear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function fixture(): { view: ImageGenerationHistoryView, record: ImageGenerationRecord } {
  const form = createImageForm({ profile: 'webgpu-wasm64-jspi' });
  const record: ImageGenerationRecord = {
    id: toImageGenerationId({ raw: 'generation' }), createdAt: 1000,
    request: { parameters: { ...form.parameters.value, prompt: 'A quiet garden', seed: '-1' }, models: [], loras: [], imageInputs: { initImage: undefined, strength: 0.75, referenceImages: [] }, preview: { ...form.preview.value }, runtime: { sourceCommit: 'a'.repeat(40), profile: 'webgpu-wasm64-jspi', weightResidency: 'auto', gpuBudgetMiB: undefined } },
    result: { binaryObjectId: toBinaryObjectId({ raw: 'final' }), width: 256, height: 256, modelVersion: 'fixture', uniformOutput: false, elapsedMs: 100 },
    previews: [{ binaryObjectId: toBinaryObjectId({ raw: 'preview' }), step: 2, steps: 8, mode: 'projection', width: 128, height: 128 }],
  };
  const view: ImageGenerationHistoryView = {
    warnings: ref([]), warningCount: ref(0),
    available: ref(true), items: shallowRef([{ id: record.id, createdAt: record.createdAt, prompt: record.request.parameters.prompt, modelName: 'fixture', binaryObjectId: record.result.binaryObjectId, width: 256, height: 256, previewCount: 1 }]), total: ref(2), loading: ref(false), error: ref(''), selected: shallowRef(), detailLoading: ref(false), detailError: ref(''),
    setQuery: vi.fn(), reload: vi.fn(async () => {}), loadMore: vi.fn(async () => {}), select: vi.fn(async () => {
      view.selected.value = record;
    }), remove: vi.fn(async () => {}), getImage: vi.fn(async () => new Blob(['PNG'], { type: 'image/png' })), clearSelection: vi.fn(), dispose: vi.fn(),
  };
  return { view, record };
}
it('selects locally without altering the form and emits reuse or image actions only after an explicit click', async () => {
  const { view, record } = fixture();
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, active: true } });
  await wrapper.get('[data-testid="image-history-item"]').trigger('click'); await flushPromises();
  expect(wrapper.emitted('reuse')).toBeUndefined(); expect(wrapper.emitted('useImage')).toBeUndefined();
  await wrapper.get('[data-testid="image-history-reuse"]').trigger('click');
  expect(wrapper.emitted('reuse')).toEqual([[{ record }]]);
  await wrapper.get('[data-testid="image-history-use-reference"]').trigger('click');
  expect(wrapper.emitted('useImage')).toEqual([[{ binaryObjectId: record.result.binaryObjectId, role: 'reference' }]]);
  expect(wrapper.text()).toContain('Requested seed: -1'); expect(wrapper.text()).toContain('does not download models');
});
it('defaults exports to plain PNG and keeps deletion scope visible next to the action', async () => {
  const { view, record } = fixture(); view.selected.value = record;
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, active: true } }); await flushPromises();
  await wrapper.get('[data-testid="image-history-download"] [data-testid="image-download-default"]').trigger('click');
  expect(onDownload).toHaveBeenLastCalledWith({ binaryObjectId: record.result.binaryObjectId, record, format: 'png', includeMetadata: false });
  await flushPromises();
  await wrapper.get('[data-testid="image-history-download"] [data-testid="image-download-options"]').trigger('click');
  const metadata = document.querySelector<HTMLInputElement>('[data-testid="image-download-metadata"]')!;
  metadata.checked = true; metadata.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('[data-testid="image-download-confirm"]')!.click();
  await flushPromises();
  expect(onDownload).toHaveBeenLastCalledWith({ binaryObjectId: record.result.binaryObjectId, record, format: 'png', includeMetadata: true });
  expect(wrapper.text()).toContain('Image files remain'); expect(wrapper.text()).toContain('ZIP backups include image files');
  await wrapper.get('[data-testid="image-history-delete"]').trigger('click'); expect(view.remove).toHaveBeenCalledExactlyOnceWith({ id: record.id });
});
it('passes search and pagination to the owner, keeps unavailable actions disabled, and shows missing images without losing record details', async () => {
  const { view, record } = fixture(); view.selected.value = record; view.getImage = vi.fn(async () => undefined);
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, active: true } }); await flushPromises();
  expect(wrapper.text()).toContain('This image file is unavailable.'); expect(wrapper.text()).toContain('A quiet garden');
  await wrapper.get('[data-testid="image-history-search"]').setValue('garden'); expect(view.setQuery).toHaveBeenCalledWith({ text: 'garden' });
  await wrapper.get('[data-testid="image-history-more"]').trigger('click'); expect(view.loadMore).toHaveBeenCalledTimes(1);
  view.available.value = false; await flushPromises(); expect(wrapper.get('[data-testid="image-history-search"]').element.matches(':disabled')).toBe(true);
});
it('releases image URLs and discards a stale async image load when its record changes', async () => {
  const pending = Promise.withResolvers<Blob | undefined>(); const getImage = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(new Blob(['new']));
  wrapper = mount(ImageHistoryImage, { props: { binaryObjectId: toBinaryObjectId({ raw: 'old' }), alt: 'old', getImage } });
  await wrapper.setProps({ binaryObjectId: toBinaryObjectId({ raw: 'new' }), alt: 'new' }); await flushPromises();
  pending.resolve(new Blob(['old'])); await flushPromises(); expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  wrapper.unmount(); wrapper = undefined; expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:history-image');
});
it('loads history thumbnails only while visible and releases their URL when they leave the viewport', async () => {
  let visibility: IntersectionObserverCallback | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      visibility = callback;
    }
    observe() {}
    disconnect = disconnect;
  });
  const getImage = vi.fn(async () => new Blob(['PNG']));
  wrapper = mount(ImageHistoryImage, { props: { binaryObjectId: toBinaryObjectId({ raw: 'visible' }), alt: 'image', getImage } });
  await flushPromises(); expect(getImage).not.toHaveBeenCalled();
  const entry = { isIntersecting: true } as IntersectionObserverEntry;
  visibility?.([entry], {} as IntersectionObserver); await flushPromises();
  expect(getImage).toHaveBeenCalledTimes(1);
  visibility?.([{ ...entry, isIntersecting: false }], {} as IntersectionObserver); await flushPromises();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:history-image');
  wrapper.unmount(); wrapper = undefined; expect(disconnect).toHaveBeenCalled();
});

it('closes the teleported viewer when reuse leaves the pane or storage becomes unavailable, without destroying history state', async () => {
  const { view, record } = fixture(); view.selected.value = record;
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, active: true, onReuse: () => wrapper?.setProps({ active: false }) }, global: { stubs: { Teleport: true } } });
  await wrapper.get('[data-testid="image-history-open-viewer"]').trigger('click'); await flushPromises();
  expect(wrapper.find('[data-testid="image-viewer"]').exists()).toBe(true);
  await wrapper.get('[data-testid="image-history-reuse"]').trigger('click'); await flushPromises();
  expect(wrapper.find('[data-testid="image-viewer"]').exists()).toBe(false);
  expect(view.selected.value).toBe(record);
  await wrapper.setProps({ active: true });
  await wrapper.get('[data-testid="image-history-open-viewer"]').trigger('click'); await flushPromises();
  view.available.value = false; await flushPromises();
  expect(wrapper.find('[data-testid="image-viewer"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="image-history-detail"]').exists()).toBe(false);
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});

it('reports a rejected deletion beside the action and keeps the selected record available', async () => {
  const { view, record } = fixture(); view.selected.value = record;
  view.remove = vi.fn(async () => {
    throw new Error('Could not update history index');
  });
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, active: true } });
  await wrapper.get('[data-testid="image-history-delete"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-testid="image-history-delete-error"]').text()).toContain('Could not update history index');
  expect(view.selected.value).toBe(record);
  expect(wrapper.get('[data-testid="image-history-delete"]').element.matches(':disabled')).toBe(false);
});

it('keeps readable records usable and labels partial counts without treating read failures as empty history', async () => {
  const { view, record } = fixture();
  view.warningCount.value = 2;
  view.warnings.value = [{ path: 'index.json', message: 'Unexpected end of JSON input' }];
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, active: true } });
  expect(wrapper.get('[data-testid="image-history-partial"]').text()).toContain('Some history files could not be read');
  expect(wrapper.get('[data-testid="image-history-readable-count"]').text()).toBe('Readable matches: 1 of 2');
  expect(wrapper.get('[data-testid="image-history-partial"] summary').text()).toBe('Read warnings (1 of 2)');
  await wrapper.get('[data-testid="image-history-item"]').trigger('click');
  await wrapper.get('[data-testid="image-history-reuse"]').trigger('click');
  expect(wrapper.emitted('reuse')).toEqual([[{ record }]]);
  view.items.value = []; view.total.value = 0;
  await flushPromises();
  expect(wrapper.get('[data-testid="image-history-readable-count"]').text()).toBe('Readable matches: 0 of 0');
  expect(wrapper.find('[data-testid="image-history-empty"]').exists()).toBe(false);
  view.warningCount.value = 0; view.warnings.value = [];
  await flushPromises();
  expect(wrapper.find('[data-testid="image-history-partial"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="image-history-empty"]').exists()).toBe(true);
});
