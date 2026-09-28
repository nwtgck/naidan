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
const confirm = vi.hoisted(() => ({ show: vi.fn(async () => false) }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: confirm.show }) }));
const onDownload = vi.fn(async () => ({ status: 'downloaded' as const }));
let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  confirm.show.mockReset(); confirm.show.mockResolvedValue(false);
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
    warnings: ref([]), warningCount: ref(0), currentPage: ref(1), pageCount: ref(1),
    available: ref(true), items: shallowRef([{ id: record.id, createdAt: record.createdAt, prompt: record.request.parameters.prompt, modelName: 'fixture', binaryObjectId: record.result.binaryObjectId, width: 256, height: 256, previewCount: 1 }]), total: ref(2), loading: ref(false), error: ref(''), selected: shallowRef(), detailLoading: ref(false), detailError: ref(''), imageInvalidation: ref(),
    setQuery: vi.fn(), reload: vi.fn(async () => {}), goToPage: vi.fn(async () => {}), select: vi.fn(async () => {
      view.selected.value = record;
    }), remove: vi.fn(async () => {}), removeImage: vi.fn(async () => {}), getImage: vi.fn(async () => new Blob(['PNG'], { type: 'image/png' })), clearSelection: vi.fn(), dispose: vi.fn(),
  };
  return { view, record };
}
it('selects locally without altering the form and emits reuse or image actions only after an explicit click', async () => {
  const { view, record } = fixture();
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true } });
  expect(wrapper.find('h2').exists()).toBe(false);
  await wrapper.get('[data-testid="image-history-item"]').trigger('click'); await flushPromises();
  expect(wrapper.emitted('reuse')).toBeUndefined(); expect(wrapper.emitted('useImage')).toBeUndefined();
  await wrapper.get('[data-testid="image-history-reuse"]').trigger('click');
  expect(wrapper.emitted('reuse')).toEqual([[{ record }]]);
  await wrapper.get('[data-testid="image-history-use-reference"]').trigger('click');
  expect(wrapper.emitted('useImage')).toEqual([[{ binaryObjectId: record.result.binaryObjectId, role: 'reference' }]]);
  const generationDetails = wrapper.get('[data-testid="image-history-generation-details"]');
  expect(generationDetails.get('summary').text()).toBe('Generation details');
  expect((generationDetails.element as HTMLDetailsElement).open).toBe(false);
  await generationDetails.get('summary').trigger('click');
  expect((generationDetails.element as HTMLDetailsElement).open).toBe(true);
  expect(generationDetails.text()).toContain('Requested seed: -1');
  expect(generationDetails.text()).toContain('does not download models');
  const json = wrapper.get('[data-testid="image-history-request-json"]');
  expect(json.text()).toContain('A quiet garden');
  expect(json.findAll('span').length).toBeGreaterThan(0);
});
it('copies the exact full prompt from the compact read-only card and reports clipboard failure', async () => {
  const { view, record } = fixture();
  const prompt = `\
  first line
second line${'  '}
`;
  record.request.parameters.prompt = prompt;
  view.selected.value = record;
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true } });
  const card = wrapper.get('[data-testid="image-history-prompt"]');
  const button = card.get('[data-testid="image-history-copy-prompt"]');
  expect(card.get('[data-testid="image-history-full-prompt"]').element.textContent).toBe(prompt);
  expect(card.find('svg').exists()).toBe(true);
  expect(button.text()).toBe('');
  expect(button.attributes('aria-label')).toBe('Copy Prompt');
  await button.trigger('click'); await flushPromises();
  expect(writeText).toHaveBeenCalledExactlyOnceWith(prompt);
  expect(button.attributes('aria-label')).toBe('Copied!');
  writeText.mockRejectedValueOnce(new Error('Permission denied'));
  await button.trigger('click'); await flushPromises();
  expect(card.get('[data-testid="image-history-copy-prompt-error"]').text()).toContain('Permission denied');
});
it('defaults exports to plain PNG and keeps deletion available beside independent scope details', async () => {
  const { view, record } = fixture(); view.selected.value = record;
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true } }); await flushPromises();
  await wrapper.get('[data-testid="image-history-download"] [data-testid="image-download-default"]').trigger('click');
  expect(onDownload).toHaveBeenLastCalledWith({ binaryObjectId: record.result.binaryObjectId, record, format: 'png', includeMetadata: false });
  await flushPromises();
  await wrapper.get('[data-testid="image-history-download"] [data-testid="image-download-options"]').trigger('click');
  const metadata = document.querySelector<HTMLInputElement>('[data-testid="image-download-metadata"]')!;
  metadata.checked = true; metadata.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('[data-testid="image-download-confirm"]')!.click();
  await flushPromises();
  expect(onDownload).toHaveBeenLastCalledWith({ binaryObjectId: record.result.binaryObjectId, record, format: 'png', includeMetadata: true });
  const section = wrapper.get('[data-testid="image-history-delete-section"]');
  const sectionClasses = section.attributes('class');
  const deleteButton = wrapper.get('[data-testid="image-history-delete"]');
  const helpButton = wrapper.get('[data-testid="image-history-delete-help-toggle"]');
  expect(deleteButton.isVisible()).toBe(true);
  expect(wrapper.find('[data-testid="image-history-delete-help"]').exists()).toBe(false);
  expect(wrapper.text()).toContain('ZIP backups include image files');
  await helpButton.trigger('click');
  expect(helpButton.attributes('aria-expanded')).toBe('true');
  expect(section.attributes('class')).toBe(sectionClasses);
  expect(wrapper.get('[data-testid="image-history-delete-help"]').isVisible()).toBe(true);
  expect(wrapper.get('[data-testid="image-history-delete-help"]').text()).toContain('Image files remain');
  expect(view.remove).not.toHaveBeenCalled();
  await helpButton.trigger('click');
  expect(wrapper.find('[data-testid="image-history-delete-help"]').exists()).toBe(false);
  await deleteButton.trigger('click'); expect(view.remove).toHaveBeenCalledExactlyOnceWith({ id: record.id });
});

it('confirms deletion of only the selected final image and keeps its history record', async () => {
  const { view, record } = fixture(); view.selected.value = record;
  confirm.show.mockResolvedValueOnce(true);
  view.removeImage = vi.fn(async ({ binaryObjectId }) => {
    view.imageInvalidation.value = { binaryObjectId, revision: 1 };
  });
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true } });
  const helpButton = wrapper.get('[data-testid="image-history-image-delete-help-toggle"]');
  expect(wrapper.get('[data-testid="image-history-delete-image"]').isVisible()).toBe(true);
  expect(wrapper.find('[data-testid="image-history-image-delete-help"]').exists()).toBe(false);
  await helpButton.trigger('click');
  expect(wrapper.get('[data-testid="image-history-image-delete-help"]').isVisible()).toBe(true);
  expect(wrapper.get('[data-testid="image-history-image-delete-help"]').text()).toContain('Other records that use this file');
  expect(view.removeImage).not.toHaveBeenCalled();
  await helpButton.trigger('click');
  await wrapper.get('[data-testid="image-history-delete-image"]').trigger('click'); await flushPromises();
  expect(confirm.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete image file', confirmButtonVariant: 'danger', message: expect.stringContaining('The history record, previews, and input images remain') }));
  expect(view.removeImage).toHaveBeenCalledExactlyOnceWith({ id: record.id, binaryObjectId: record.result.binaryObjectId });
  expect(view.remove).not.toHaveBeenCalled();
  expect(view.selected.value).toBe(record);
  expect(view.items.value).toHaveLength(1);
});

it('discards a confirmed final-image deletion if selection or storage changed during confirmation', async () => {
  const { view, record } = fixture(); view.selected.value = record;
  const first = Promise.withResolvers<boolean>();
  const second = Promise.withResolvers<boolean>();
  confirm.show.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true } });
  await wrapper.get('[data-testid="image-history-delete-image"]').trigger('click'); await flushPromises();
  view.selected.value = { ...record };
  first.resolve(true); await flushPromises();
  expect(view.removeImage).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="image-history-delete-image"]').trigger('click'); await flushPromises();
  view.available.value = false;
  view.available.value = true;
  second.resolve(true); await flushPromises();
  expect(view.removeImage).not.toHaveBeenCalled();
});

it('shows final-image deletion errors even while its details remain closed', async () => {
  const { view, record } = fixture(); view.selected.value = record;
  confirm.show.mockResolvedValueOnce(true);
  view.removeImage = vi.fn(async () => {
    throw new Error('Could not delete image file');
  });
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true } });
  await wrapper.get('[data-testid="image-history-delete-image"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-testid="image-history-image-delete-error"]').text()).toContain('Could not delete image file');
  expect(wrapper.get('[data-testid="image-history-image-delete-error"]').isVisible()).toBe(true);
  expect(wrapper.get('[data-testid="image-history-image-delete-help-toggle"]').attributes('aria-expanded')).toBe('false');
  expect(view.selected.value).toBe(record);
});
it('passes search and pagination to the owner, keeps unavailable actions disabled, and shows missing images without losing record details', async () => {
  const { view, record } = fixture(); view.selected.value = record; view.getImage = vi.fn(async () => undefined);
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true } }); await flushPromises();
  expect(wrapper.text()).toContain('This image file is unavailable.'); expect(wrapper.text()).toContain('A quiet garden');
  await wrapper.get('[data-testid="image-history-search"]').setValue('garden'); expect(view.setQuery).toHaveBeenCalledWith({ text: 'garden' });
  view.pageCount.value = 2; await flushPromises();
  await wrapper.get('[data-testid="image-history-next-page"]').trigger('click'); expect(view.goToPage).toHaveBeenCalledExactlyOnceWith({ page: 2 });
  view.available.value = false; await flushPromises(); expect(wrapper.get('[data-testid="image-history-search"]').element.matches(':disabled')).toBe(true);
});
it('keeps displayed thumbnails and selected actions stable while search status changes', async () => {
  const { view, record } = fixture();
  view.selected.value = record;
  view.setQuery = vi.fn(() => {
    view.loading.value = true;
  });
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true } });
  await flushPromises();
  const item = wrapper.get('[data-testid="image-history-item"]').element;
  const image = wrapper.get('[data-testid="image-history-item"] img').element;
  const searchStatus = wrapper.get('[data-testid="image-history-search-status"]').element;
  const input = wrapper.get('[data-testid="image-history-search"]');
  expect(input.attributes('placeholder')).toBe('Search prompts and models');
  expect(wrapper.get(`label[for="${input.attributes('id')}"]`).classes()).toContain('sr-only');
  for (const query of ['g', 'ga', 'garden', '']) {
    await wrapper.get('[data-testid="image-history-search"]').setValue(query);
    expect(wrapper.get('[data-testid="image-history-search-status"]').text()).toBe('Loading history…');
    expect(wrapper.get('[data-testid="image-history-results"]').attributes('aria-busy')).toBe('true');
    expect(wrapper.get('[data-testid="image-history-item"]').element).toBe(item);
    expect(wrapper.get('[data-testid="image-history-item"] img').element).toBe(image);
    expect(wrapper.find('[data-testid="image-history-empty"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="image-history-next-page"]').element.matches(':disabled')).toBe(true);
  }
  await wrapper.get('[data-testid="image-history-reuse"]').trigger('click');
  expect(wrapper.emitted('reuse')).toEqual([[{ record }]]);
  view.loading.value = false;
  view.error.value = 'Could not read the requested search';
  await flushPromises();
  expect(wrapper.get('[data-testid="image-history-search-status"]').element).toBe(searchStatus);
  expect(wrapper.get('[data-testid="image-history-search-status"]').text()).toBe('');
  expect(wrapper.get('[data-testid="image-history-results"]').attributes('aria-busy')).toBe('false');
  expect(wrapper.get('[data-testid="image-history-item"]').element).toBe(item);
  expect(wrapper.get('[data-testid="image-history-next-page"]').element.matches(':disabled')).toBe(true);
  expect(wrapper.text()).toContain('Could not read the requested search');
});
it('replaces a bounded page of cards and exposes first, previous, next and last page controls', async () => {
  const { view } = fixture();
  const source = view.items.value[0]!;
  const records = Array.from({ length: 1005 }, (_, index) => ({
    ...source, id: toImageGenerationId({ raw: `generation-${index}` }), binaryObjectId: toBinaryObjectId({ raw: `image-${index}` }), prompt: `Image ${index}`,
  }));
  view.items.value = records.slice(0, 40);
  view.total.value = records.length;
  view.pageCount.value = 26;
  view.goToPage = vi.fn(async ({ page }: { page: number }) => {
    view.items.value = records.slice((page - 1) * 40, page * 40);
    view.currentPage.value = page;
  });
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true } });
  await flushPromises();
  expect(wrapper.findAll('[data-testid="image-history-item"]')).toHaveLength(40);
  expect(wrapper.get('[data-testid="image-history-page-number"]').text()).toBe('1 / 26');
  expect(wrapper.get('[data-testid="image-history-previous-page"]').element.matches(':disabled')).toBe(true);
  await wrapper.get('[data-testid="image-history-next-page"]').trigger('click'); await flushPromises();
  expect(view.goToPage).toHaveBeenLastCalledWith({ page: 2 });
  expect(wrapper.findAll('[data-testid="image-history-item"]')).toHaveLength(40);
  expect(wrapper.get('[data-testid="image-history-item"]').text()).toContain('Image 40');
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(40);
  await wrapper.get('[data-testid="image-history-last-page"]').trigger('click'); await flushPromises();
  expect(view.goToPage).toHaveBeenLastCalledWith({ page: 26 });
  expect(wrapper.findAll('[data-testid="image-history-item"]')).toHaveLength(5);
  expect(wrapper.get('[data-testid="image-history-page-number"]').text()).toBe('26 / 26');
  expect(wrapper.get('[data-testid="image-history-next-page"]').element.matches(':disabled')).toBe(true);
  await wrapper.get('[data-testid="image-history-previous-page"]').trigger('click'); await flushPromises();
  expect(view.goToPage).toHaveBeenLastCalledWith({ page: 25 });
  await wrapper.get('[data-testid="image-history-first-page"]').trigger('click'); await flushPromises();
  expect(view.goToPage).toHaveBeenLastCalledWith({ page: 1 });
  expect(wrapper.findAll('[data-testid="image-history-item"]')).toHaveLength(40);
  view.available.value = false; await flushPromises();
  expect(wrapper.find('[data-testid="image-history-pagination"]').exists()).toBe(true);
  for (const button of wrapper.findAll('[data-testid="image-history-pagination"] button')) expect(button.element.matches(':disabled')).toBe(true);
});
it('releases image URLs and discards a stale async image load when its record changes', async () => {
  const pending = Promise.withResolvers<Blob | undefined>(); const getImage = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(new Blob(['new']));
  wrapper = mount(ImageHistoryImage, { props: { binaryObjectId: toBinaryObjectId({ raw: 'old' }), width: 512, height: 512, alt: 'old', getImage } });
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
  wrapper = mount(ImageHistoryImage, { props: { binaryObjectId: toBinaryObjectId({ raw: 'visible' }), width: 512, height: 256, thumbnail: true, alt: 'image', getImage } });
  await flushPromises(); expect(getImage).not.toHaveBeenCalled();
  const entry = { isIntersecting: true } as IntersectionObserverEntry;
  visibility?.([entry], {} as IntersectionObserver); await flushPromises();
  expect(getImage).toHaveBeenCalledTimes(1);
  visibility?.([{ ...entry, isIntersecting: false }], {} as IntersectionObserver); await flushPromises();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:history-image');
  wrapper.unmount(); wrapper = undefined; expect(disconnect).toHaveBeenCalled();
});

it('reserves detail image dimensions while loading and after releasing an offscreen image', async () => {
  let visibility: IntersectionObserverCallback | undefined;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      visibility = callback;
    }
    observe() {}
    disconnect() {}
  });
  const getImage = vi.fn(async () => new Blob(['PNG']));
  wrapper = mount(ImageHistoryImage, { props: { binaryObjectId: toBinaryObjectId({ raw: 'portrait' }), width: 512, height: 768, alt: 'portrait', getImage } });
  const frame = wrapper.get('[data-testid="image-history-frame"]');
  const reservedStyle = frame.attributes('style');
  expect(reservedStyle).toContain('aspect-ratio: 512 / 768');
  expect(reservedStyle).toContain('width: 512px');
  expect(getImage).not.toHaveBeenCalled();
  visibility?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  await flushPromises();
  expect(frame.attributes('style')).toBe(reservedStyle);
  expect(wrapper.get('img').attributes()).toMatchObject({ width: '512', height: '768' });
  visibility?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
  await flushPromises();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:history-image');
  expect(wrapper.find('img').exists()).toBe(false);
  expect(frame.attributes('style')).toBe(reservedStyle);
  visibility?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  await flushPromises();
  expect(getImage).toHaveBeenCalledTimes(2);
  expect(frame.attributes('style')).toBe(reservedStyle);
});

it('keeps the displayed image and settings together while another record is loading and blocks its actions', async () => {
  const { view, record } = fixture();
  view.selected.value = record;
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true } });
  await flushPromises();
  const detail = wrapper.get('[data-testid="image-history-detail"]').element;
  const image = wrapper.get('[data-testid="image-history-open-viewer"] img').element;
  view.detailLoading.value = true;
  await flushPromises();
  expect(wrapper.get('[data-testid="image-history-detail"]').element).toBe(detail);
  expect(wrapper.get('[data-testid="image-history-open-viewer"] img').element).toBe(image);
  expect(wrapper.get('[data-testid="image-history-detail"]').attributes('aria-busy')).toBe('true');
  for (const id of ['image-history-reuse', 'image-history-use-initial', 'image-history-use-reference', 'image-history-open-viewer', 'image-history-delete']) {
    const button = wrapper.get(`[data-testid="${id}"]`);
    expect(button.element.matches(':disabled')).toBe(true);
    await button.trigger('click');
  }
  expect(wrapper.get('[data-testid="image-history-download"] [data-testid="image-download-default"]').element.matches(':disabled')).toBe(true);
  expect(wrapper.emitted('reuse')).toBeUndefined();
  expect(wrapper.emitted('useImage')).toBeUndefined();
  expect(view.remove).not.toHaveBeenCalled();
  view.detailLoading.value = false;
  view.detailError.value = 'Cannot read next image';
  await flushPromises();
  expect(wrapper.get('[data-testid="image-history-detail"]').element).toBe(detail);
  await wrapper.get('[data-testid="image-history-reuse"]').trigger('click');
  expect(wrapper.emitted('reuse')).toEqual([[{ record }]]);
});

it('closes the teleported viewer when reuse leaves the pane or storage becomes unavailable, without destroying history state', async () => {
  const { view, record } = fixture(); view.selected.value = record;
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true, onReuse: () => wrapper?.setProps({ active: false }) }, global: { stubs: { Teleport: true } } });
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
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true } });
  await wrapper.get('[data-testid="image-history-delete"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-testid="image-history-delete-error"]').text()).toContain('Could not update history index');
  expect(wrapper.get('[data-testid="image-history-delete-error"]').isVisible()).toBe(true);
  expect(wrapper.get('[data-testid="image-history-delete-help-toggle"]').attributes('aria-expanded')).toBe('false');
  expect(view.selected.value).toBe(record);
  expect(wrapper.get('[data-testid="image-history-delete"]').element.matches(':disabled')).toBe(false);
});

it('keeps readable records usable and labels partial counts without treating read failures as empty history', async () => {
  const { view, record } = fixture();
  view.warningCount.value = 2;
  view.warnings.value = [{ path: 'index.json', message: 'Unexpected end of JSON input' }];
  wrapper = mount(ImageGenerationHistory, { props: { onDownload, view, disabled: false, editorDisabled: false, active: true } });
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
