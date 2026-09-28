import { createDisabledImageLibrary } from '@/features/stable-diffusion-cpp-browser/library-standalone';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { computed, effectScope, ref } from 'vue';
import type { HostModelDirectoryChoice } from '@/features/stable-diffusion-cpp-browser/library-view';
import ImageModelCatalog from './ImageModelCatalog.vue';
import { imageCatalogLoras } from '@/features/stable-diffusion-cpp-browser/lora-catalog';
import { useImageLibrary } from '@/features/stable-diffusion-cpp-browser/use-image-library';
import { downloadImageRecipe, type ImageRecipeDownloadRequest } from '@/features/stable-diffusion-cpp-browser/logic/catalog-download';
let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn() }, locks: { request: vi.fn() } });
});
it.each(['directory API', 'mutation lock'] as const)('disables OPFS acquisition before its owner is invoked without the %s', async missing => {
  vi.stubGlobal('navigator', { storage: missing === 'directory API' ? {} : { getDirectory: vi.fn() }, locks: missing === 'mutation lock' ? undefined : { request: vi.fn() } });
  const network = vi.fn(), download = vi.fn((args: ImageRecipeDownloadRequest) => downloadImageRecipe({ ...args, fetch: network }));
  const scope = effectScope();
  const library = scope.run(() => useImageLibrary({ blocked: () => false, onSelection() {}, dependencies: {
    list: vi.fn(async () => []), scan: vi.fn(async () => ({ candidates: [], issues: [] })), import: vi.fn(), download,
  } }))!;
  try {
    wrapper = mount(ImageModelCatalog, { props: { disabled: false, view: library } });
    const button = wrapper.get<HTMLButtonElement>('[data-testid="recipe-download-selected-z-image-turbo"]');
    expect(button.element.disabled).toBe(true);
    expect(wrapper.get<HTMLOptionElement>('option[value="opfs"]').element.disabled).toBe(true);
    expect(wrapper.get('[data-testid="image-opfs-download-unavailable"]').text()).toContain('Browser storage (OPFS)');
    await button.trigger('click');
    expect(download).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    expect(library.downloadState.value).toBe('idle');
    expect(library.failure.value).toBe('');
  } finally {
    scope.stop();
  }
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals();
});
it('shows all static recipes without networking or remote resources when opened', async () => {
  const fetch = vi.fn(), xhr = vi.fn(), worker = vi.fn();
  vi.stubGlobal('fetch', fetch); vi.stubGlobal('XMLHttpRequest', xhr); vi.stubGlobal('Worker', worker);
  wrapper = mount(ImageModelCatalog, { props: { disabled: false, view: createDisabledImageLibrary() } });
  expect(wrapper.get('[data-testid="image-catalog-toggle"]').attributes('aria-expanded')).toBe('true');
  for (const detail of wrapper.findAll('[data-testid="image-recipe-details"]')) expect(detail.attributes('inert')).toBeDefined();
  for (const toggle of wrapper.findAll('[data-testid^="recipe-details-toggle-"]')) await toggle.trigger('click');
  for (const detail of wrapper.findAll('[data-testid="image-recipe-details"]')) expect(detail.attributes('inert')).toBeUndefined();
  await flushPromises();
  expect(wrapper.findAll('article')).toHaveLength(8);
  expect(wrapper.text()).toContain('Z-Image-Turbo'); expect(wrapper.text()).toContain('Qwen Image 2.1');
  expect(wrapper.text()).toContain('Z-Image Base'); expect(wrapper.text()).toContain('SDXL Base 1.0');
  expect(wrapper.text()).toContain('FLUX.2 [klein] 4B Distilled'); expect(wrapper.text()).toContain('Anima Turbo 1.1');
  expect(wrapper.text()).toContain('Krea 2 Turbo'); expect(wrapper.text()).toContain('ERNIE-Image-Turbo');
  expect(wrapper.text()).toContain('split_files/vae/ae.safetensors');
  expect(wrapper.text()).toContain('Qwen3VL-8B-Instruct-Q4_K_M.gguf');
  expect(wrapper.get('[data-testid="image-recipe-z-image-turbo"]').text()).not.toContain('optional');
  expect(wrapper.findAll('img, iframe, script, link')).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled(); expect(xhr).not.toHaveBeenCalled(); expect(worker).not.toHaveBeenCalled();
});
it('uses only explicit, referrer-free browser links to immutable file revisions', () => {
  wrapper = mount(ImageModelCatalog, { props: { disabled: false, view: createDisabledImageLibrary() } });
  const downloads = wrapper.findAll('[data-testid^="recipe-download-selected-"]');
  expect(downloads).toHaveLength(8);
  for (const link of wrapper.findAll('a')) {
    const url = new URL(link.attributes('href')!);
    expect(url.origin).toBe('https://huggingface.co');
    expect(url.pathname).toMatch(/^\/[\w.-]+\/[\w.-]+(?:$|\/(resolve|blob)\/[0-9a-f]{40}\/)/);
    expect(link.attributes('rel')).toBe('noopener noreferrer');
    expect(link.attributes('referrerpolicy')).toBe('no-referrer');
  }
  for (const button of downloads) expect(button.element.tagName).toBe('BUTTON');
});
it('labels the SDXL primary as a checkpoint and shows its explicit external VAE', async () => {
  wrapper = mount(ImageModelCatalog, { props: { disabled: false, view: createDisabledImageLibrary() } });
  const card = wrapper.get('[data-testid="image-recipe-sdxl-base-1.0"]');
  expect(card.get('[data-testid="recipe-option-sdxl-base-1.0-model"]').attributes('aria-label')).toBe('Checkpoint file');
  expect(card.find('[data-testid="recipe-option-sdxl-base-1.0-diffusion"]').exists()).toBe(false);
  await card.get('[data-testid="recipe-details-toggle-sdxl-base-1.0"]').trigger('click');
  expect(card.text()).toContain('sd_xl_base_1.0.safetensors');
  expect(card.text()).toContain('sdxl_vae.safetensors');
  expect(card.text()).toContain('madebyollin/sdxl-vae-fp16-fix');
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
it('offers a separate explicit reference-LoRA download without changing the base recipe selection', async () => {
  const view = createDisabledImageLibrary(), entry = imageCatalogLoras[0]!;
  const available = ref(false); view.loraAvailable = () => available.value;
  view.downloadLora = vi.fn(); view.downloadRecipe = vi.fn(); view.chooseRecipe = vi.fn();
  wrapper = mount(ImageModelCatalog, { props: { disabled: false, view } });
  const optional = wrapper.get('[data-testid="catalog-lora-krea2-style-reference"]');
  expect(optional.text()).toContain('Optional LoRA'); expect(optional.text()).toContain('Requires a reference image');
  expect(view.downloadLora).not.toHaveBeenCalled();
  await optional.get('[data-testid="catalog-lora-download-krea2-style-reference"]').trigger('click');
  expect(view.downloadLora).toHaveBeenCalledExactlyOnceWith({ id: entry.id });
  expect(view.downloadRecipe).not.toHaveBeenCalled(); expect(view.chooseRecipe).not.toHaveBeenCalled();
  available.value = true; await flushPromises();
  expect(optional.find('[data-testid="catalog-lora-download-krea2-style-reference"]').exists()).toBe(false);
  expect(optional.get('[data-testid="catalog-lora-saved-krea2-style-reference"]').text()).toContain('choose in LoRA controls');
  expect(view.chooseRecipe).not.toHaveBeenCalled();
});
it('keeps the optional LoRA visible but disabled in an unavailable build', async () => {
  const view = createDisabledImageLibrary(); view.downloadLora = vi.fn();
  wrapper = mount(ImageModelCatalog, { props: { disabled: true, view } });
  const button = wrapper.get('[data-testid="catalog-lora-download-krea2-style-reference"]');
  expect(button.element.matches(':disabled')).toBe(true); await button.trigger('click');
  expect(view.downloadLora).not.toHaveBeenCalled();
});
it('keeps option changes offline and sends a frozen choice only on the explicit download action', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const available = ref(0);
  const view = { ...createDisabledImageLibrary(), downloadRecipe: vi.fn(async () => {
    available.value = 3;
  }), chooseRecipe: vi.fn(),
  ready: computed(() => available.value === 3),
  recipeAvailability: () => ({ available: available.value, total: 3, selected: false, bytes: 32 }) };
  wrapper = mount(ImageModelCatalog, { props: { disabled: false, view } });
  await wrapper.get('[data-testid="recipe-option-z-image-turbo-diffusion"]').setValue('q8-0');
  expect(view.downloadRecipe).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="recipe-download-selected-z-image-turbo"]').trigger('click');
  expect(view.downloadRecipe).toHaveBeenCalledWith({ recipeId: 'z-image-turbo', selections: { diffusion: 'q8-0' } });
  await flushPromises();
  expect(wrapper.emitted('selected')).toBeUndefined();
  await wrapper.get('[data-testid="recipe-use-local-z-image-turbo"]').trigger('click');
  expect(view.chooseRecipe).toHaveBeenCalledWith({ recipeId: 'z-image-turbo', selections: { diffusion: 'q8-0' } });
  expect(wrapper.emitted('selected')).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
});

it('allows permission requests on explicit downloads but blocks unavailable registrations and registry writes', async () => {
  const entry = ref<HostModelDirectoryChoice>({ id: 'root-a', name: 'models', access: 'prompt', error: undefined });
  const view = createDisabledImageLibrary();
  view.hostDirectories = {
    ...view.hostDirectories, supported: computed(() => true), entries: computed(() => [entry.value]),
    destination: ref('root-a'),
  };
  view.downloadRecipe = vi.fn(async () => {});
  wrapper = mount(ImageModelCatalog, { props: { disabled: false, view } });
  const button = () => wrapper!.get<HTMLButtonElement>('[data-testid="recipe-download-selected-z-image-turbo"]');
  expect(wrapper.get<HTMLOptionElement>('option[value="root-a"]').element.disabled).toBe(false);
  expect(button().element.disabled).toBe(false);
  await button().trigger('click');
  expect(view.downloadRecipe).toHaveBeenCalledOnce();
  entry.value = { ...entry.value, access: 'read' };
  await flushPromises();
  expect(button().element.disabled).toBe(false);
  entry.value = { ...entry.value, access: 'missing' };
  await flushPromises();
  expect(button().element.disabled).toBe(true);
  view.hostDirectories.destination.value = 'opfs';
  view.hostDirectories.busy.value = true;
  await flushPromises();
  expect(button().element.disabled).toBe(true);
  view.hostDirectories.busy.value = false;
  await flushPromises();
  expect(button().element.disabled).toBe(false);
});

it('explains a local scan next to disabled download actions without queuing a hidden request', async () => {
  const view = createDisabledImageLibrary(); view.downloadRecipe = vi.fn(); view.scanState.value = 'scanning';
  wrapper = mount(ImageModelCatalog, { props: { disabled: false, view } });
  const card = wrapper.get('[data-testid="image-recipe-z-image-turbo"]');
  expect(card.get('[data-testid="image-catalog-scan-status"]').text()).toContain('Checking saved models');
  expect(card.get('[data-testid="recipe-download-selected-z-image-turbo"]').element.matches(':disabled')).toBe(true);
  view.scanState.value = 'idle'; await flushPromises();
  expect(card.find('[data-testid="image-catalog-scan-status"]').exists()).toBe(false);
  expect(view.downloadRecipe).not.toHaveBeenCalled();
  await card.get('[data-testid="recipe-download-selected-z-image-turbo"]').trigger('click');
  expect(view.downloadRecipe).toHaveBeenCalledTimes(1);
});
