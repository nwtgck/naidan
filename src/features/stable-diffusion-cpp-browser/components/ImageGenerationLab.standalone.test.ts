import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationLab from './ImageGenerationLab.vue';

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
  expect(wrapper.get('h1').text()).toBe('Image generation lab');
  expect(wrapper.get('[data-testid="image-unavailable"]').text()).toContain('hosted');
  expect(wrapper.find('[data-testid="image-file-model"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="image-prompt"]').exists()).toBe(true);
  expect(wrapper.findAll('fieldset')).toHaveLength(3);
  expect(wrapper.find('[data-testid="image-model-library"]').exists()).toBe(true);
  for (const field of wrapper.findAll('input, select, textarea, button')) {
    if (field.attributes('data-testid') === 'image-catalog-toggle' || field.attributes('data-testid')?.startsWith('recipe-details-toggle-')) {
      // Presentation stays interactive; it never authorizes hosted capabilities.
      await field.trigger('click');
    } else expect(field.element.matches(':disabled'), field.html()).toBe(true);
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
