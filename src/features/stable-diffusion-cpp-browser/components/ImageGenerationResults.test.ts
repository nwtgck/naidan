import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { toImageGenerationId } from '@/01-models/ids';
import { computed, ref, watch } from 'vue';
import { createImageGallery } from '@/features/stable-diffusion-cpp-browser/image-gallery';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useImageGeneration } from '@/features/stable-diffusion-cpp-browser/use-image-generation-standalone';
import ImageGenerationResults from './ImageGenerationResults.vue';
let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
  vi.unstubAllGlobals();
});
it.each([
  { draft: '101', expected: 100 },
  { draft: '', expected: 20 },
  { draft: '-2', expected: 1 },
  { draft: '3.7', expected: 3 },
  { draft: '12', expected: 12 },
])('commits result retention $draft as $expected on change', async ({ draft, expected }) => {
  const view = useImageGeneration();
  view.supported = computed(() => true);
  view.maxResults.value = 20;
  wrapper = mount(ImageGenerationResults, { props: { view, active: true } });
  const input = wrapper.get<HTMLInputElement>('[data-testid="image-result-limit"]');
  input.element.value = draft;
  await input.trigger('input');
  expect(view.maxResults.value).toBe(20);
  await input.trigger('change');
  expect(view.maxResults.value).toBe(expected);
  expect(input.element.value).toBe(String(expected));
});

it('keeps result images while typing a larger retention limit, including when another image arrives', async () => {
  let sequence = 0;
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => `blob:retained-result-${++sequence}`);
    static override revokeObjectURL = vi.fn();
  });
  const view = useImageGeneration();
  view.supported = computed(() => true);
  view.maxResults.value = 20;
  const gallery = createImageGallery<Omit<typeof view.results.value[number], 'id' | 'url'>>({ initialLimit: 20, maxBytes: 10000 });
  const add = () => {
    gallery.add({ blob: new Blob(['image']), width: 1, height: 1,
      metadata: { parameters: { ...view.parameters.value }, modelVersion: 'fixture', uniformOutput: false, elapsedMs: 100 } });
    view.results.value = gallery.entries();
  };
  // Connect the real gallery to the view using the hosted owner's limit contract.
  const stop = watch(view.maxResults, value => {
    gallery.setLimit({ value });
    view.results.value = gallery.entries();
  });
  try {
    for (let i = 0; i < 5; i++) add();
    wrapper = mount(ImageGenerationResults, { props: { view, active: true } });
    const input = wrapper.get<HTMLInputElement>('[data-testid="image-result-limit"]');
    for (const draft of ['1', '10', '100']) {
      input.element.value = draft;
      await input.trigger('input');
      expect(view.maxResults.value).toBe(20);
      add();
      await flushPromises();
      expect(input.element.value).toBe(draft);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    }
    expect(gallery.entries()).toHaveLength(8);
    await input.trigger('change');
    expect(view.maxResults.value).toBe(100);
    for (let i = 0; i < 94; i++) add();
    expect(gallery.entries()).toHaveLength(100);
    await input.setValue('2');
    expect(view.maxResults.value).toBe(2);
    expect(view.results.value).toHaveLength(2);
    expect(gallery.entries()).toHaveLength(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(100);
  } finally {
    stop(); gallery.clear();
  }
});
it.each(['card', 'viewer'])('keeps an existing result downloadable from its %s after selecting an unsupported profile', async location => {
  const supported = ref(true);
  const view = useImageGeneration();
  view.supported = computed(() => supported.value);
  view.results.value = [{ id: 1, url: 'blob:result', parameters: { ...view.parameters.value }, modelVersion: 'fixture', uniformOutput: false, elapsedMs: 100 }];
  let finishDownload: (() => void) | undefined;
  const pending = new Promise<void>(resolve => {
    finishDownload = resolve;
  });
  view.downloadResult = vi.fn(async () => {
    await pending;
    return { status: 'downloaded' as const };
  });
  wrapper = mount(ImageGenerationResults, { props: { view, active: true }, global: { stubs: { Teleport: true } } });
  if (location === 'viewer') await wrapper.get('[data-testid="image-generated-result"] button').trigger('click');
  const menu = () => wrapper!.get(location === 'viewer' ? '[data-testid="image-viewer"] [data-testid="image-download-menu"]' : '[data-testid="image-result-download"]');
  const download = () => menu().get<HTMLButtonElement>('[data-testid="image-download-default"]');
  expect(download().element.disabled).toBe(false);
  supported.value = false;
  await flushPromises();
  expect(download().element.disabled).toBe(false);
  await download().trigger('click');
  expect(view.downloadResult).toHaveBeenCalledWith({ resultId: 1, format: 'png', includeMetadata: false });
  expect(download().element.disabled).toBe(true);
  await download().trigger('click');
  expect(view.downloadResult).toHaveBeenCalledTimes(1);
  finishDownload?.();
  await flushPromises();
  expect(download().element.disabled).toBe(false);
  await menu().get('[data-testid="image-download-options"]').trigger('click');
  await menu().get('[data-testid="image-download-format"]').setValue('webp');
  await menu().get('[data-testid="image-download-metadata"]').setValue(true);
  await menu().get('[data-testid="image-download-confirm"]').trigger('click');
  expect(view.downloadResult).toHaveBeenLastCalledWith({ resultId: 1, format: 'webp', includeMetadata: true });
});

it('keeps the successful image downloadable when history saving fails and retries only the save', async () => {
  const view = useImageGeneration();
  view.supported = computed(() => true);
  view.historySaving.supported = computed(() => true);
  view.historySaving.status.value = 'failed';
  view.historySaving.pendingCount.value = 1;
  view.historySaving.error.value = 'quota exceeded';
  view.historySaving.retry = vi.fn(async () => {});
  view.downloadResult = vi.fn(async () => ({ status: 'downloaded' as const }));
  view.results.value = [{ id: 1, url: 'blob:result', parameters: { ...view.parameters.value }, modelVersion: 'fixture', uniformOutput: false, elapsedMs: 100 }];
  wrapper = mount(ImageGenerationResults, { props: { view, active: true } });
  expect(wrapper.get('[data-testid="image-generated-result"]').findAll('button').some(button => button.text() === 'Remove')).toBe(false);
  expect(wrapper.get('[data-testid="image-history-save-failed"]').text()).toContain('The image was generated');
  expect(view.failure.value).toBe('');
  await wrapper.get('[data-testid="image-result-download"] [data-testid="image-download-default"]').trigger('click');
  expect(view.downloadResult).toHaveBeenCalledWith({ resultId: 1, format: 'png', includeMetadata: false });
  await flushPromises();
  await wrapper.get('[data-testid="image-result-download"] [data-testid="image-download-options"]').trigger('click');
  const metadata = document.querySelector<HTMLInputElement>('[data-testid="image-download-metadata"]')!;
  metadata.checked = true; metadata.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('[data-testid="image-download-confirm"]')!.click();
  await flushPromises();
  expect(view.downloadResult).toHaveBeenLastCalledWith({ resultId: 1, format: 'png', includeMetadata: true });
  await wrapper.get('[data-testid="image-history-retry-save"]').trigger('click');
  expect(view.historySaving.retry).toHaveBeenCalledTimes(1);
  view.historySaving.status.value = 'saved'; await flushPromises();
  expect(wrapper.find('[data-testid="image-history-save-failed"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="image-history-saving"]').text()).toContain('Saved to My images');
  view.historySaving.status.value = 'idle'; await flushPromises();
  expect(wrapper.get('[data-testid="image-history-pending-saves"]').text()).toContain('Unsaved generations: 1');
  expect(wrapper.find('[data-testid="image-history-save-failed"]').exists()).toBe(false);
});

it('closes an expanded result when navigating away without clearing the generated image', async () => {
  const view = useImageGeneration();
  view.results.value = [{ id: 1, url: 'blob:result', parameters: { ...view.parameters.value }, modelVersion: 'fixture', uniformOutput: false, elapsedMs: 100 }];
  wrapper = mount(ImageGenerationResults, { props: { view, active: true }, global: { stubs: { Teleport: true } } });
  await wrapper.get('[data-testid="image-generated-result"] button').trigger('click');
  expect(wrapper.find('[data-testid="image-viewer"]').exists()).toBe(true);
  await wrapper.setProps({ active: false });
  expect(wrapper.find('[data-testid="image-viewer"]').exists()).toBe(false);
  expect(view.results.value).toHaveLength(1);
});

it('keeps pending saves visible but disables retries until OPFS storage is available again', async () => {
  const view = useImageGeneration();
  const supported = ref(true);
  view.historySaving.supported = computed(() => supported.value);
  view.historySaving.pendingCount.value = 2;
  view.historySaving.retry = vi.fn(async () => {});
  wrapper = mount(ImageGenerationResults, { props: { view, active: true } });
  supported.value = false;
  await flushPromises();
  const retry = wrapper.get('[data-testid="image-history-retry-save"]');
  expect(retry.element.matches(':disabled')).toBe(true);
  expect(wrapper.get('[data-testid="image-history-pending-saves"]').text()).toContain('Return to OPFS storage');
  await retry.trigger('click');
  expect(view.historySaving.retry).not.toHaveBeenCalled();
  supported.value = true;
  await flushPromises();
  expect(retry.element.matches(':disabled')).toBe(false);
  await retry.trigger('click');
  expect(view.historySaving.retry).toHaveBeenCalledTimes(1);
});

it('opens history details independently of the save switch', async () => {
  const view = useImageGeneration();
  view.historySaving.supported = computed(() => true);
  wrapper = mount(ImageGenerationResults, { props: { view, active: true } });
  const panel = wrapper.get('[data-testid="image-history-saving"]');
  const closedClasses = panel.attributes('class');
  const header = panel.element.firstElementChild;
  const label = wrapper.get('[data-testid="image-save-history"]').element.closest('label');
  const details = wrapper.get('[data-testid="image-history-help-toggle"]');
  const initial = view.historySaving.enabled.value;
  expect(details.attributes('aria-expanded')).toBe('false');
  await details.trigger('click');
  expect(details.attributes('aria-expanded')).toBe('true');
  expect(panel.attributes('class')).toBe(closedClasses);
  expect(panel.element.firstElementChild).toBe(header);
  expect(wrapper.get('[data-testid="image-save-history"]').element.closest('label')).toBe(label);
  expect(view.historySaving.enabled.value).toBe(initial);
  await wrapper.get('[data-testid="image-save-history"]').setValue(!initial);
  expect(details.attributes('aria-expanded')).toBe('true');
  expect(view.historySaving.enabled.value).toBe(!initial);
  await details.trigger('click');
  expect(details.attributes('aria-expanded')).toBe('false');
  expect(panel.attributes('class')).toBe(closedClasses);
});

it('links only a result with a successful saved record without a redundant workspace history button', async () => {
  const view = useImageGeneration();
  const saved = ref(false);
  const id = toImageGenerationId({ raw: 'saved-result' });
  view.savedHistoryId = () => saved.value ? id : undefined;
  view.history.available.value = true;
  view.results.value = [{ id: 1, url: 'blob:result', parameters: { ...view.parameters.value }, modelVersion: 'fixture', uniformOutput: false, elapsedMs: 100 }];
  wrapper = mount(ImageGenerationResults, { props: { view, active: true } });
  expect(wrapper.find('[data-testid="image-open-history"]').exists()).toBe(false);
  expect(wrapper.emitted('openHistory')).toBeUndefined();
  expect(wrapper.find('[data-testid="image-result-view-saved"]').exists()).toBe(false);
  view.historySaving.status.value = 'failed';
  await flushPromises();
  expect(wrapper.find('[data-testid="image-result-view-saved"]').exists()).toBe(false);
  saved.value = true;
  await flushPromises();
  await wrapper.get('[data-testid="image-result-view-saved"]').trigger('click');
  expect(wrapper.emitted('openHistory')?.at(-1)).toEqual([{ id }]);
});

it('replaces the current result placeholder with its live image and final image in the same reserved canvas', async () => {
  const busy = ref(false);
  const view = useImageGeneration();
  view.busy = computed(() => busy.value);
  view.supported = computed(() => true);
  view.parameters.value.width = 768; view.parameters.value.height = 512;
  const oldResult = { id: 1, url: 'blob:old', parameters: { ...view.parameters.value }, modelVersion: 'fixture', uniformOutput: false, elapsedMs: 100 };
  view.results.value = [oldResult];
  const oldPreview = { type: 'naidan-image-preview-v1' as const, runId: 1, revision: 0, step: 2, steps: 8, mode: 'projection' as const, width: 32, height: 16, url: 'blob:old-preview', id: 1, elapsedMs: 100 };
  view.livePreview.value = oldPreview;
  wrapper = mount(ImageGenerationResults, { props: { view, active: true } });
  busy.value = true; await flushPromises();
  const grid = wrapper.get('[data-testid="image-result-grid"]');
  expect(grid.element.firstElementChild?.getAttribute('data-testid')).toBe('image-pending-result');
  expect(wrapper.find('[data-testid="image-generation-current-preview"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="image-live-preview"]').exists()).toBe(false);
  expect(wrapper.findAll('[data-testid="image-generated-result"]')).toHaveLength(1);
  const canvasStyle = wrapper.get('[data-testid="image-generation-canvas"]').attributes('style');
  expect(canvasStyle).toContain('aspect-ratio: 768 / 512');
  view.livePreview.value = { ...oldPreview, id: 2, runId: 2, url: 'blob:current-preview' };
  await flushPromises();
  expect(wrapper.get('[data-testid="image-generation-current-preview"]').attributes('src')).toBe('blob:current-preview');
  expect(wrapper.get('[data-testid="image-generation-canvas"]').attributes('style')).toBe(canvasStyle);
  expect(wrapper.get('[data-testid="image-generation-progress"]').attributes('data-running')).toBe('false');
  // Final pixels arrive before asynchronous history saving releases busy.
  view.results.value = [{ ...oldResult, id: 2, url: 'blob:final' }, oldResult];
  await flushPromises();
  expect(wrapper.find('[data-testid="image-pending-result"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="image-generated-result"] img').attributes('src')).toBe('blob:final');
  expect(wrapper.get('[data-testid="image-result-canvas"]').attributes('style')).toBe(canvasStyle);
  expect(wrapper.findAll('[data-testid="image-generated-result"]')).toHaveLength(2);
  view.results.value = [oldResult]; await flushPromises();
  expect(wrapper.find('[data-testid="image-pending-result"]').exists()).toBe(false);
  view.results.value = [{ ...oldResult, id: 2, url: 'blob:final' }, oldResult]; await flushPromises();
  busy.value = false; await flushPromises();
  busy.value = true; await flushPromises();
  expect(wrapper.find('[data-testid="image-pending-result"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="image-generation-current-preview"]').exists()).toBe(false);
  // Removing an older completed image must not look like completion of this run.
  view.results.value = [oldResult]; await flushPromises();
  expect(wrapper.find('[data-testid="image-pending-result"]').exists()).toBe(true);
  await wrapper.setProps({ active: false });
  expect(wrapper.get('[data-testid="image-generation-progress"]').attributes('data-running')).toBe('false');
  await wrapper.setProps({ active: true });
  view.stopping.value = true; await flushPromises();
  expect(wrapper.get('[data-testid="image-generation-progress"]').attributes('data-running')).toBe('false');
  busy.value = false; view.stopping.value = false; view.cancelled.value = true; await flushPromises();
  expect(wrapper.find('[data-testid="image-pending-result"]').exists()).toBe(false);
  expect(wrapper.findAll('[data-testid="image-generated-result"]')).toHaveLength(1);
  busy.value = true; await flushPromises();
  view.failure.value = 'generation failed'; busy.value = false; await flushPromises();
  expect(wrapper.find('[data-testid="image-pending-result"]').exists()).toBe(false);
});

it('locks the history policy during a run and restores editing afterward only in supported storage', async () => {
  const view = useImageGeneration(), busy = ref(false), supported = ref(true);
  view.busy = computed(() => busy.value); view.historySaving.supported = computed(() => supported.value);
  wrapper = mount(ImageGenerationResults, { props: { view, active: true } });
  const toggle = wrapper.get<HTMLInputElement>('[data-testid="image-save-history"]');
  await toggle.setValue(false); expect(view.historySaving.enabled.value).toBe(false);
  busy.value = true; await flushPromises();
  expect(toggle.element.disabled).toBe(true); expect(toggle.element.checked).toBe(false);
  busy.value = false; await flushPromises();
  expect(toggle.element.disabled).toBe(false);
  await toggle.setValue(true); expect(view.historySaving.enabled.value).toBe(true);
  supported.value = false; await flushPromises(); expect(toggle.element.disabled).toBe(true);
});
