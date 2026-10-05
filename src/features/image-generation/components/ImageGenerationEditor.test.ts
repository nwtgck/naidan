import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useImageGeneration } from '@/features/image-generation/use-image-generation-standalone';
import { recommendationForSelection } from '@/features/stable-diffusion-cpp-browser/recommendations';
import ImageGenerationEditor from './ImageGenerationEditor.vue';

let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
});

it('keeps next-run fields editable while context controls and generation remain locked', async () => {
  const view = useImageGeneration(), restoring = ref(false);
  view.supported = computed(() => true); view.formDisabled = computed(() => true);
  view.draftDisabled = computed(() => restoring.value); view.busy = computed(() => true);
  view.progress.value = { phase: 'model', step: 0, steps: 0 };
  view.seedMode.value = 'fixed';
  wrapper = mount(ImageGenerationEditor, { props: { view, active: true } });
  for (const key of ['prompt', 'negative-prompt', 'width', 'height', 'steps', 'guidance', 'distilled-guidance', 'sampler', 'scheduler', 'seed', 'seed-mode', 'resolution-presets', 'swap-resolution', 'randomize-seed']) {
    expect(wrapper.get(`[data-testid="image-${key}"]`).element.matches(':disabled')).toBe(false);
  }
  for (const key of ['generate', 'file-model', 'bf16-weight-type', 'weight-residency', 'release-model']) {
    expect(wrapper.get(`[data-testid="image-${key}"]`).element.matches(':disabled')).toBe(true);
  }
  await wrapper.get('[data-testid="image-resolution-presets"]').setValue('768x1024');
  await wrapper.get('[data-testid="image-swap-resolution"]').trigger('click');
  expect([view.parameters.value.width, view.parameters.value.height]).toEqual([1024, 768]);
  restoring.value = true; await flushPromises();
  expect(wrapper.get('[data-testid="image-prompt"]').element.matches(':disabled')).toBe(true);
  expect(wrapper.get('[data-testid="image-width"]').element.matches(':disabled')).toBe(true);
  const dimensions = [view.parameters.value.width, view.parameters.value.height];
  await wrapper.get('[data-testid="image-swap-resolution"]').trigger('click');
  expect([view.parameters.value.width, view.parameters.value.height]).toEqual(dimensions);
});

it.each(['import', 'download'])('only locks conflicting model layout and preset actions during %s', async transfer => {
  const pending = ref(true);
  const view = useImageGeneration();
  view.formDisabled = computed(() => false);
  view.draftDisabled = computed(() => false);
  view.supported = computed(() => true);
  view.library.importing = computed(() => pending.value && transfer === 'import');
  view.library.downloading = computed(() => pending.value && transfer === 'download');
  view.recommendation = computed(() => recommendationForSelection({ model: { family: 'z-image', variant: 'turbo', evidence: [] } }));
  view.applyRecommendedSettings = vi.fn();
  view.resetFiles = vi.fn();
  wrapper = mount(ImageGenerationEditor, { props: { view, active: true } });
  const layout = wrapper.get('[data-testid="image-model-options"] select');
  const preset = wrapper.get('[data-testid="image-apply-recommendation"]');
  expect(layout.element.matches(':disabled')).toBe(transfer === 'import');
  expect(preset.element.matches(':disabled')).toBe(transfer === 'import');
  await preset.trigger('click');
  expect(view.applyRecommendedSettings).toHaveBeenCalledTimes(transfer === 'import' ? 0 : 1);
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
  expect(view.applyRecommendedSettings).toHaveBeenCalledTimes(transfer === 'import' ? 1 : 2);
});
