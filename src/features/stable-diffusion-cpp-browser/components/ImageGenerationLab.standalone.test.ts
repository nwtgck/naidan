import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationLab from './ImageGenerationLab.vue';

vi.mock('@/features/stable-diffusion-cpp-browser/use-image-benchmark', () => import('@/features/stable-diffusion-cpp-browser/use-image-benchmark-standalone'));
vi.mock('@/features/stable-diffusion-cpp-browser/use-image-generation', () => import('@/features/stable-diffusion-cpp-browser/use-image-generation-standalone'));
// These fail at import time, not only if their exported functions are called.
vi.mock('../use-image-generation-hosted', () => {
  throw new Error('Hosted policy leaked into standalone');
});
vi.mock('../capabilities', () => {
  throw new Error('Device probes leaked into standalone');
});
vi.mock('../types', () => {
  throw new Error('Runtime schemas leaked into standalone');
});
vi.mock('@/features/stable-diffusion-cpp-browser/worker/client', () => {
  throw new Error('Worker client leaked into standalone');
});

let wrapper: VueWrapper<InstanceType<typeof ImageGenerationLab>> | undefined;
const worker = vi.fn(), fetch = vi.fn(), reader = vi.fn();
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.clearAllMocks();
  vi.stubGlobal('Worker', worker); vi.stubGlobal('fetch', fetch); vi.stubGlobal('FileReaderSync', reader);
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals();
});

it('keeps the entire image form visible and disabled in standalone', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  expect(wrapper.get('h1').text()).toBe('Image generation entirely in your browser');
  expect(wrapper.get('[data-testid="image-unavailable"]').text()).toContain('hosted');
  expect(wrapper.find('[data-testid="image-file-model"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="image-prompt"]').exists()).toBe(true);
  // Model, basic draft, sampling, runtime, and benchmark controls stay locked.
  const fieldsets = wrapper.findAll<HTMLFieldSetElement>('fieldset');
  expect(fieldsets).toHaveLength(5);
  for (const fieldset of fieldsets) expect(fieldset.element.disabled).toBe(true);
  expect(wrapper.get('[data-testid="image-input-initial"]').element.matches(':disabled')).toBe(true);
  expect(wrapper.get('[data-testid="image-input-references"]').element.matches(':disabled')).toBe(true);
  expect(wrapper.get('[data-testid="image-lora-files"]').element.matches(':disabled')).toBe(true);
  expect(wrapper.find('[data-testid="image-model-library"]').exists()).toBe(true);
  for (const field of wrapper.findAll('input, select, textarea, button')) {
    if (field.attributes('role') === 'tab' || ['image-return-to-generation', 'image-open-history', 'image-results-prepare'].includes(field.attributes('data-testid') ?? '')) {
      await field.trigger('click');
    } else if (['image-catalog-toggle', 'image-preview-settings-toggle', 'image-history-help-toggle'].includes(field.attributes('data-testid') ?? '') || field.attributes('data-testid')?.startsWith('recipe-details-toggle-')) {
      // Presentation stays interactive; it never authorizes hosted capabilities.
      await field.trigger('click');
    } else expect(field.element.matches(':disabled'), field.html()).toBe(true);
  }
  expect(wrapper.get('[data-testid="image-preview-settings-toggle"]').attributes('aria-expanded')).toBe('true');
  expect(wrapper.get('[data-testid="image-history-help-toggle"]').attributes('aria-expanded')).toBe('true');
  for (const testId of ['image-preview-enabled', 'image-preview-mode', 'image-preview-start-step', 'image-preview-interval', 'image-preview-size', 'image-keep-previews', 'image-save-history', 'image-generate']) {
    expect(wrapper.get(`[data-testid="${testId}"]`).element.matches(':disabled')).toBe(true);
  }
  expect(wrapper.text()).not.toContain('Ollama');
  const catalog = wrapper.get('[data-testid="image-model-catalog"]');
  expect(catalog.text()).toContain('Z-Image-Turbo');
  for (const link of catalog.findAll('a')) {
    expect(link.attributes('href')).toBeUndefined(); expect(link.attributes('aria-disabled')).toBe('true');
  }
  expect(worker).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
});

it('does not execute even when generation is invoked programmatically', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  await wrapper.vm.TEST_ONLY.generate();
  expect(wrapper.vm.TEST_ONLY.files.value).toEqual({});
  expect(wrapper.vm.TEST_ONLY.results.value).toEqual([]);
  expect(worker).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
});

it('allows opening history while keeping local history reads and saving disabled', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  expect(wrapper.get('[data-testid="image-save-history"]').element.matches(':disabled')).toBe(true);
  await wrapper.get('[data-testid="image-tab-history"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-testid="image-history-unavailable"]').text()).toContain('OPFS');
  expect(wrapper.get('[data-testid="image-history-search"]').element.matches(':disabled')).toBe(true);
  expect(wrapper.get('[data-testid="image-history-refresh"]').element.matches(':disabled')).toBe(true);
  expect(worker).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
});
