import { createDisabledImageLibrary } from '@/features/stable-diffusion-cpp-browser/library-standalone';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageModelCatalog from './ImageModelCatalog.vue';
let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals();
});
it('shows both static recipes without networking or remote resources when opened', async () => {
  const fetch = vi.fn(), xhr = vi.fn(), worker = vi.fn();
  vi.stubGlobal('fetch', fetch); vi.stubGlobal('XMLHttpRequest', xhr); vi.stubGlobal('Worker', worker);
  wrapper = mount(ImageModelCatalog, { props: { disabled: false, view: createDisabledImageLibrary() } });
  expect(wrapper.get('details').attributes('open')).toBeUndefined();
  for (const detail of wrapper.findAll('details')) {
    detail.element.setAttribute('open', ''); await detail.trigger('toggle');
  }
  await flushPromises();
  expect(wrapper.findAll('article')).toHaveLength(2);
  expect(wrapper.text()).toContain('Z-Image-Turbo'); expect(wrapper.text()).toContain('Qwen Image 2.1');
  expect(wrapper.text()).toContain('split_files/vae/ae.safetensors');
  expect(wrapper.text()).toContain('Qwen3VL-8B-Instruct-Q4_K_M.gguf');
  expect(wrapper.text()).not.toContain('optional');
  expect(wrapper.findAll('img, iframe, script, link')).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled(); expect(xhr).not.toHaveBeenCalled(); expect(worker).not.toHaveBeenCalled();
});
it('uses only explicit, referrer-free browser links to immutable file revisions', () => {
  wrapper = mount(ImageModelCatalog, { props: { disabled: false, view: createDisabledImageLibrary() } });
  const downloads = wrapper.findAll('[data-testid^="recipe-download-selected-"]');
  expect(downloads).toHaveLength(2);
  for (const link of wrapper.findAll('a')) {
    expect(link.attributes('href')).toMatch(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/(resolve|blob)\/[0-9a-f]{40}\//);
    expect(link.attributes('rel')).toBe('noopener noreferrer');
    expect(link.attributes('referrerpolicy')).toBe('no-referrer');
  }
  for (const button of downloads) expect(button.element.tagName).toBe('BUTTON');
});
it('keeps catalog content visible but navigation inert when the feature is disabled', async () => {
  wrapper = mount(ImageModelCatalog, { props: { disabled: true, view: createDisabledImageLibrary() } });
  expect(wrapper.text()).toContain('Qwen Image 2.1');
  for (const link of wrapper.findAll('a')) {
    expect(link.attributes('href')).toBeUndefined(); expect(link.attributes('aria-disabled')).toBe('true');
    expect(link.attributes('tabindex')).toBe('-1');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true }); link.element.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  }
  await wrapper.setProps({ disabled: false, view: createDisabledImageLibrary() });
  expect(wrapper.get('a').attributes('href')).toMatch(/^https:/);
});
it('keeps option changes offline and sends a frozen choice only on the explicit download action', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const view = { ...createDisabledImageLibrary(), downloadRecipe: vi.fn(async () => undefined), chooseRecipe: vi.fn() };
  wrapper = mount(ImageModelCatalog, { props: { disabled: false, view } });
  await wrapper.get('[data-testid="recipe-option-z-image-turbo-diffusion"]').setValue('q8-0');
  expect(view.downloadRecipe).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="recipe-download-selected-z-image-turbo"]').trigger('click');
  expect(view.downloadRecipe).toHaveBeenCalledWith({ recipeId: 'z-image-turbo', selections: { diffusion: 'q8-0' } });
  await wrapper.get('[data-testid="recipe-use-local-z-image-turbo"]').trigger('click');
  expect(view.chooseRecipe).toHaveBeenCalledWith({ recipeId: 'z-image-turbo', selections: { diffusion: 'q8-0' } });
  expect(fetch).not.toHaveBeenCalled();
});
