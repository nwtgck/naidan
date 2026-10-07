import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed, ref, watch } from 'vue';
import { createImageGallery } from '@/features/image-generation/image-gallery';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useImageGeneration } from '@/features/image-generation/test-utils/unavailable-image-view';
import type { PreviewFrame } from '@/features/stable-diffusion-cpp-browser/types';
import ImageGenerationPreview from './ImageGenerationPreview.vue';

let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals();
});

it.each([
  { draft: '101', expected: 100 },
  { draft: '', expected: 20 },
  { draft: '-2', expected: 1 },
  { draft: '3.7', expected: 3 },
  { draft: '12', expected: 12 },
])('commits preview retention $draft as $expected on change', async ({ draft, expected }) => {
  const view = useImageGeneration();
  view.supported = computed(() => true);
  view.maxPreviews.value = 20;
  wrapper = mount(ImageGenerationPreview, { props: { view, active: true, livePlacement: 'panel' } });
  const input = wrapper.get<HTMLInputElement>('[data-testid="image-preview-limit"]');
  input.element.value = draft;
  await input.trigger('input');
  expect(view.maxPreviews.value).toBe(20);
  await input.trigger('change');
  expect(view.maxPreviews.value).toBe(expected);
  expect(input.element.value).toBe(String(expected));
});

it('keeps preview images while typing a larger retention limit, including when another frame arrives', async () => {
  let sequence = 0;
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => `blob:retained-preview-${++sequence}`);
    static override revokeObjectURL = vi.fn();
  });
  const view = useImageGeneration();
  view.supported = computed(() => true);
  view.maxPreviews.value = 20;
  const gallery = createImageGallery<Omit<typeof view.previewSnapshots.value[number], 'id' | 'url'>>({ initialLimit: 20, maxBytes: 10000 });
  const add = () => {
    gallery.add({ blob: new Blob(['image']), width: 1, height: 1,
      metadata: { type: 'naidan-image-preview-v1', runId: 1, revision: 0, step: 2, steps: 8,
        mode: 'vae', width: 1, height: 1, elapsedMs: 2500 } });
    view.previewSnapshots.value = gallery.entries();
  };
  // Connect the real gallery to the view using the hosted owner's limit contract.
  const stop = watch(view.maxPreviews, value => {
    gallery.setLimit({ value });
    view.previewSnapshots.value = gallery.entries();
  });
  try {
    for (let i = 0; i < 5; i++) add();
    wrapper = mount(ImageGenerationPreview, { props: { view, active: true, livePlacement: 'panel' } });
    const input = wrapper.get<HTMLInputElement>('[data-testid="image-preview-limit"]');
    for (const draft of ['1', '10', '100']) {
      input.element.value = draft;
      await input.trigger('input');
      expect(view.maxPreviews.value).toBe(20);
      add();
      await flushPromises();
      expect(input.element.value).toBe(draft);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    }
    expect(gallery.entries()).toHaveLength(8);
    await input.trigger('change');
    expect(view.maxPreviews.value).toBe(100);
    for (let i = 0; i < 94; i++) add();
    expect(gallery.entries()).toHaveLength(100);
    await input.setValue('2');
    expect(view.maxPreviews.value).toBe(2);
    expect(view.previewSnapshots.value).toHaveLength(2);
    expect(gallery.entries()).toHaveLength(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(100);
  } finally {
    stop(); gallery.clear();
  }
});

it.each(['card', 'viewer'])('keeps a retained preview downloadable from its %s after selecting an unsupported profile', async location => {
  const supported = ref(true);
  const view = useImageGeneration();
  view.supported = computed(() => supported.value);
  view.previewSnapshots.value = [{ type: 'naidan-image-preview-v1', runId: 1, revision: 0, step: 2, steps: 8,
    mode: 'vae', width: 32, height: 32, url: 'blob:saved-preview', id: 2, elapsedMs: 2500 }];
  view.downloadPreview = vi.fn(async () => ({ status: 'downloaded' as const }));
  wrapper = mount(ImageGenerationPreview, { props: { view, active: true, livePlacement: 'panel' }, global: { stubs: { Teleport: true } } });
  if (location === 'viewer') await wrapper.get('[data-testid="image-preview-snapshot"] button').trigger('click');
  const menu = () => wrapper!.get(location === 'viewer' ? '[data-testid="image-viewer"] [data-testid="image-download-menu"]' : '[data-testid="image-preview-snapshot"] [data-testid="image-download-menu"]');
  const download = () => menu().get<HTMLButtonElement>('[data-testid="image-download-default"]');
  expect(download().element.disabled).toBe(false);
  supported.value = false;
  await flushPromises();
  expect(download().element.disabled).toBe(false);
  expect(wrapper.get<HTMLInputElement>('[data-testid="image-preview-enabled"]').element.disabled).toBe(true);
  await download().trigger('click');
  expect(view.downloadPreview).toHaveBeenCalledWith({ previewId: 2, format: 'png', includeMetadata: false });
  await flushPromises();
  await menu().get('[data-testid="image-download-options"]').trigger('click');
  await menu().get('[data-testid="image-download-format"]').setValue('jpeg');
  await menu().get('[data-testid="image-download-metadata"]').setValue(true);
  await menu().get('[data-testid="image-download-confirm"]').trigger('click');
  expect(view.downloadPreview).toHaveBeenLastCalledWith({ previewId: 2, format: 'jpeg', includeMetadata: true });
});

function openPreview({ width = 32, height = 32, mode = 'projection', maxEdge = 256 }: {
  width?: number, height?: number, mode?: PreviewFrame['mode'], maxEdge?: number,
} = {}) {
  // Use the view-only facade with synthetic frame metadata. No native inference.
  const view = { ...useImageGeneration(), supported: computed(() => true), busy: computed(() => true) };
  view.parameters.value.width = 512; view.parameters.value.height = 512;
  view.preview.value = { ...view.preview.value, enabled: true, maxEdge };
  view.livePreview.value = { type: 'naidan-image-preview-v1', runId: 1, revision: 0, step: 2, steps: 8,
    mode, width, height, url: 'blob:original-small-preview', id: 1, elapsedMs: 2500 };
  wrapper = mount(ImageGenerationPreview, { props: { view, active: true, livePlacement: 'panel' } });
  return { view, wrapper };
}

it.each([
  { width: 32, height: 32, displayWidth: 256, displayHeight: 256 },
  { width: 32, height: 16, displayWidth: 256, displayHeight: 128 },
  { width: 16, height: 32, displayWidth: 128, displayHeight: 256 },
])('displays a $width × $height projection at the configured size without changing its pixels or URL', ({ width, height, displayWidth, displayHeight }) => {
  const { view, wrapper } = openPreview({ width, height });
  const image = wrapper.get('[data-testid="image-live-preview"] img');
  expect(image.attributes('width')).toBe(String(displayWidth));
  expect(image.attributes('height')).toBe(String(displayHeight));
  expect(image.attributes('style')).toContain(`max-width: min(100%, ${width}px)`);
  expect(image.attributes('src')).toBe('blob:original-small-preview');
  expect(view.livePreview.value).toMatchObject({ width, height });
  expect(wrapper.get('figcaption').text()).toContain(`${width} × ${height}`);
});

it('changes presentation immediately while busy and preserves explicit native-size display', async () => {
  const { wrapper, view } = openPreview({ width: 32, height: 16 });
  const size = wrapper.get('[data-testid="image-preview-size"]');
  expect(size.element.matches(':disabled')).toBe(false);
  await size.setValue(128);
  expect(wrapper.get('[data-testid="image-live-preview"] img').attributes('width')).toBe('128');
  await size.setValue(512);
  expect(wrapper.get('[data-testid="image-live-preview"] img').attributes('width')).toBe('512');
  await size.setValue(0);
  expect(wrapper.get('[data-testid="image-live-preview"] img').attributes('width')).toBe('32');
  expect(wrapper.get('[data-testid="image-live-preview"] img').attributes('height')).toBe('16');
  expect(view.livePreview.value?.url).toBe('blob:original-small-preview');
});

it.each([
  { width: 128, height: 64, expectedWidth: 128, expectedHeight: 64 },
  { width: 512, height: 256, expectedWidth: 256, expectedHeight: 128 },
])('keeps detailed decoder output within its native size and the display cap', ({ width, height, expectedWidth, expectedHeight }) => {
  const { wrapper } = openPreview({ width, height, mode: 'vae' });
  const image = wrapper.get('[data-testid="image-live-preview"] img');
  expect(image.attributes('width')).toBe(String(expectedWidth));
  expect(image.attributes('height')).toBe(String(expectedHeight));
});


it('shows elapsed time and the configurable first preview step', async () => {
  const { wrapper, view } = openPreview({ width: 64, height: 64, mode: 'vae' });
  expect(wrapper.get('figcaption').text()).toContain('Time 2.5 s');
  const start = wrapper.get('[data-testid="image-preview-start-step"]');
  await start.setValue(6);
  expect(view.preview.value.startStep).toBe(6);
});

it('sizes saved projection thumbnails while downloading the original frame and preserving metadata', async () => {
  const { view, wrapper } = openPreview({ width: 16, height: 32 });
  view.previewSnapshots.value = [{ ...view.livePreview.value!, id: 2, url: 'blob:saved-small-preview' }];
  await wrapper.vm.$nextTick();
  const snapshot = wrapper.get('[data-testid="image-preview-snapshot"]');
  expect(snapshot.get('img').attributes('width')).toBe('128');
  expect(snapshot.get('img').attributes('height')).toBe('256');
  expect(snapshot.get('img').attributes('style')).toContain('max-width: min(100%, 16px)');
  view.downloadPreview = vi.fn(async () => ({ status: 'downloaded' as const }));
  await snapshot.get('[data-testid="image-download-default"]').trigger('click');
  expect(view.downloadPreview).toHaveBeenCalledWith({ previewId: 2, format: 'png', includeMetadata: false });
  expect(view.previewSnapshots.value[0]).toMatchObject({ width: 16, height: 32 });
});

it('defaults history ON without starting preview, and preserves an explicit opt-out across ON/OFF toggles', async () => {
  const view = { ...useImageGeneration(), supported: computed(() => true) };
  wrapper = mount(ImageGenerationPreview, { props: { view, active: true, livePlacement: 'panel' } });
  expect(view.preview.value.enabled).toBe(false);
  expect(view.preview.value.mode).toBe('vae');
  expect(view.keepPreviews.value).toBe(true);
  await wrapper.get('[data-testid="image-preview-enabled"]').setValue(true);
  expect(view.keepPreviews.value).toBe(true);
  await wrapper.get('[data-testid="image-keep-previews"]').setValue(false);
  await wrapper.get('[data-testid="image-preview-enabled"]').setValue(false);
  await wrapper.get('[data-testid="image-preview-enabled"]').setValue(true);
  expect(view.keepPreviews.value).toBe(false);
});

it('opens preview details independently of the preview switch', async () => {
  const view = { ...useImageGeneration(), supported: computed(() => true) };
  wrapper = mount(ImageGenerationPreview, { props: { view, active: true, livePlacement: 'panel' } });
  const panel = wrapper.get('[data-testid="image-preview-panel"]');
  const closedClasses = panel.attributes('class');
  const header = panel.element.firstElementChild;
  const label = wrapper.get('[data-testid="image-preview-enabled"]').element.closest('label');
  const details = wrapper.get('[data-testid="image-preview-settings-toggle"]');
  expect(details.attributes('aria-expanded')).toBe('false');
  await details.trigger('click');
  expect(details.attributes('aria-expanded')).toBe('true');
  expect(panel.attributes('class')).toBe(closedClasses);
  expect(panel.element.firstElementChild).toBe(header);
  expect(wrapper.get('[data-testid="image-preview-enabled"]').element.closest('label')).toBe(label);
  expect(view.preview.value.enabled).toBe(false);
  await wrapper.get('[data-testid="image-preview-enabled"]').setValue(true);
  expect(details.attributes('aria-expanded')).toBe('true');
  expect(view.preview.value.enabled).toBe(true);
  await details.trigger('click');
  expect(details.attributes('aria-expanded')).toBe('false');
  expect(panel.attributes('class')).toBe(closedClasses);
});

it('closes an expanded snapshot when its pane becomes inactive while preserving the running preview', async () => {
  const { view, wrapper } = openPreview({});
  view.previewSnapshots.value = [{ ...view.livePreview.value!, id: 2, url: 'blob:saved-preview' }];
  await wrapper.vm.$nextTick();
  await wrapper.get('[data-testid="image-preview-snapshot"] button').trigger('click');
  expect(document.querySelector('[data-testid="image-viewer"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="image-viewer-zoom-in"]')).not.toBeNull();
  await wrapper.setProps({ active: false });
  expect(document.querySelector('[data-testid="image-viewer"]')).toBeNull();
  expect(view.livePreview.value?.url).toBe('blob:original-small-preview');
  expect(view.previewSnapshots.value).toHaveLength(1);
});
