import { afterEach, beforeEach, expect, it } from 'vitest';
import { computed } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { useImageGeneration } from '@/features/image-generation/test-utils/unavailable-image-view.test-support';
import { useImageBenchmark } from '@/features/stable-diffusion-cpp-browser/use-image-benchmark-standalone';
import ImageBenchmark from '@/features/stable-diffusion-cpp-browser/components/ImageBenchmark.vue';
import ImageGenerationEditor from './ImageGenerationEditor.vue';
import ImageGenerationPreview from './ImageGenerationPreview.vue';

enableAutoUnmount(afterEach);

afterEach(() => {
  document.body.innerHTML = '';
});

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it('closes the real editor menu on an inactive route without changing the draft or dimensions', async () => {
  const view = useImageGeneration();
  view.supported = computed(() => true);
  view.formDisabled = computed(() => false);
  view.draftDisabled = computed(() => false);
  view.parameters.value.width = 256;
  view.parameters.value.height = 256;
  view.parameters.value.prompt = 'Keep the current prompt';
  const wrapper = mount(ImageGenerationEditor, { attachTo: document.body, props: { view, active: true } });
  const input = wrapper.get('[data-testid="image-prompt"]').element;
  await wrapper.get('[data-testid="image-resolution-presets"]').trigger('click');
  const option = document.querySelector<HTMLButtonElement>('[data-testid="settings-select-option-512x512"]');
  expect(option).not.toBeNull();
  await wrapper.setProps({ active: false });
  option?.click();
  expect(wrapper.get('[data-testid="image-resolution-presets"]').attributes('aria-expanded')).toBe('false');
  expect([view.parameters.value.width, view.parameters.value.height]).toEqual([256, 256]);
  expect(view.parameters.value.prompt).toBe('Keep the current prompt');
  expect(wrapper.get('[data-testid="image-prompt"]').element).toBe(input);
});

it.each(['details', 'route'] as const)('closes the preview menu when its %s becomes hidden', async boundary => {
  const view = useImageGeneration();
  view.supported = computed(() => true);
  view.preview.value.maxEdge = 128;
  const wrapper = mount(ImageGenerationPreview, { attachTo: document.body, props: { view, active: true, livePlacement: 'panel' } });
  await wrapper.get('[data-testid="image-preview-settings-toggle"]').trigger('click');
  await wrapper.get('[data-testid="image-preview-size"]').trigger('click');
  const option = document.querySelector<HTMLButtonElement>('[data-testid="settings-select-option-256"]');
  expect(option).not.toBeNull();
  switch (boundary) {
  case 'details': await wrapper.get('[data-testid="image-preview-settings-toggle"]').trigger('click');
    break;
  case 'route': await wrapper.setProps({ active: false });
    break;
  default: {
    const exhaustive: never = boundary;
    throw new Error(String(exhaustive));
  }
  }
  option?.click();
  expect(wrapper.get('[data-testid="image-preview-size"]').attributes('aria-expanded')).toBe('false');
  expect(view.preview.value.maxEdge).toBe(128);
});

it('closes diagnostics controls when leaving their route without changing the protocol', async () => {
  const generation = useImageGeneration();
  const bench = useImageBenchmark({ generation });
  bench.available = computed(() => true);
  bench.protocol.value.mode = 'cold-warm';
  const wrapper = mount(ImageBenchmark, { attachTo: document.body, props: { bench, generation, active: true } });
  await wrapper.get('[data-testid="benchmark-mode"]').trigger('click');
  const option = document.querySelector<HTMLButtonElement>('[data-testid="settings-select-option-fresh-each"]');
  expect(option).not.toBeNull();
  await wrapper.setProps({ active: false });
  option?.click();
  expect(bench.protocol.value.mode).toBe('cold-warm');
  expect(wrapper.get('[data-testid="benchmark-mode"]').attributes('aria-expanded')).toBe('false');
});
