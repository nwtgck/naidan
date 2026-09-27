import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { toImageGenerationId } from '@/01-models/ids';
import { computed, ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useImageGeneration } from '@/features/stable-diffusion-cpp-browser/use-image-generation-standalone';
import ImageGenerationResults from './ImageGenerationResults.vue';
let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
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

it('opens My images explicitly and links only a result with a successful saved record', async () => {
  const view = useImageGeneration();
  const saved = ref(false);
  const id = toImageGenerationId({ raw: 'saved-result' });
  view.savedHistoryId = () => saved.value ? id : undefined;
  view.history.available.value = true;
  view.results.value = [{ id: 1, url: 'blob:result', parameters: { ...view.parameters.value }, modelVersion: 'fixture', uniformOutput: false, elapsedMs: 100 }];
  wrapper = mount(ImageGenerationResults, { props: { view, active: true } });
  await wrapper.get('[data-testid="image-open-history"]').trigger('click');
  expect(wrapper.emitted('openHistory')).toEqual([[{ id: undefined }]]);
  expect(wrapper.find('[data-testid="image-result-view-saved"]').exists()).toBe(false);
  view.historySaving.status.value = 'failed';
  await flushPromises();
  expect(wrapper.find('[data-testid="image-result-view-saved"]').exists()).toBe(false);
  saved.value = true;
  await flushPromises();
  await wrapper.get('[data-testid="image-result-view-saved"]').trigger('click');
  expect(wrapper.emitted('openHistory')?.at(-1)).toEqual([{ id }]);
});
