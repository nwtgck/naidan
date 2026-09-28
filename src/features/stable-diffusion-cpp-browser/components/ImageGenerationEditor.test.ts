import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useImageGeneration } from '@/features/stable-diffusion-cpp-browser/use-image-generation-standalone';
import { recommendationForSelection } from '@/features/stable-diffusion-cpp-browser/recommendations';
import ImageGenerationEditor from './ImageGenerationEditor.vue';

let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
});

it.each(['import', 'download'])('locks model layout and preset actions during %s without blocking prompt editing', async transfer => {
  const pending = ref(true);
  const view = useImageGeneration();
  view.formDisabled = computed(() => false);
  view.supported = computed(() => true);
  view.library.importing = computed(() => pending.value && transfer === 'import');
  view.library.downloading = computed(() => pending.value && transfer === 'download');
  view.recommendation = computed(() => recommendationForSelection({ model: { family: 'z-image', variant: 'turbo', evidence: [] } }));
  view.applyRecommendedSettings = vi.fn();
  view.resetFiles = vi.fn();
  wrapper = mount(ImageGenerationEditor, { props: { view, active: true } });
  const layout = wrapper.get('[data-testid="image-model-options"] select');
  const preset = wrapper.get('[data-testid="image-apply-recommendation"]');
  expect(layout.element.matches(':disabled')).toBe(true);
  expect(preset.element.matches(':disabled')).toBe(true);
  await preset.trigger('click');
  expect(view.applyRecommendedSettings).not.toHaveBeenCalled();
  expect(view.resetFiles).not.toHaveBeenCalled();
  const prompt = wrapper.get('[data-testid="image-prompt"]');
  expect(prompt.element.matches(':disabled')).toBe(false);
  await prompt.setValue('a quiet afternoon');
  expect(view.parameters.value.prompt).toBe('a quiet afternoon');

  pending.value = false;
  await flushPromises();
  expect(layout.element.matches(':disabled')).toBe(false);
  expect(preset.element.matches(':disabled')).toBe(false);
  await layout.setValue('components');
  expect(view.layout.value).toBe('components');
  expect(view.resetFiles).toHaveBeenCalledOnce();
  await preset.trigger('click');
  expect(view.applyRecommendedSettings).toHaveBeenCalledOnce();
});
