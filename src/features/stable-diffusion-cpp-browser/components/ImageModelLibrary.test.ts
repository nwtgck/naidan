import { beforeEach, expect, it, vi } from 'vitest';
import { computed } from 'vue';
import ImageModelConfiguration from './ImageModelConfiguration.vue';
import { mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { createDisabledImageLibrary } from '@/features/stable-diffusion-cpp-browser/library-standalone';
import ImageModelLibrary from './ImageModelLibrary.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it('shows inspection phase/path/progress and offers cancel while inspecting', async () => {
  const view = createDisabledImageLibrary();
  view.scanState.value = 'scanning';
  view.scanProgress.value = { phase: 'headers', completed: 3, total: 7, path: 'user/weights/model.gguf' };
  view.cancelScan = vi.fn();
  const wrapper = mount(ImageModelLibrary, { props: { active: true, view, disabled: false } });
  expect(wrapper.get('[data-testid="image-inventory-progress"]').text()).toContain('3 / 7');
  expect(wrapper.text()).toContain('user/weights/model.gguf');
  const picker = wrapper.get('[data-testid="image-model-picker-trigger"]');
  expect(picker.text()).toBe('Choose a model');
  expect(picker.element.matches(':disabled')).toBe(true);
  await picker.trigger('click');
  expect(wrapper.find('[data-testid="image-model-picker-popup"]').exists()).toBe(false);
  await wrapper.get('[data-testid="image-cancel-scan"]').trigger('click');
  expect(view.cancelScan).toHaveBeenCalledOnce(); wrapper.unmount();
});

it('closes companion choices during a scan without resetting the selected file', async () => {
  const view = createDisabledImageLibrary();
  view.components = computed(() => [{ slot: 'vae', selected: 'selected-vae', required: true, choices: [{ id: 'selected-vae', label: 'VAE', detail: 'OPFS: models/vae.gguf', status: 'matching', evidence: [], issue: undefined }] }]);
  const wrapper = mount(ImageModelConfiguration, { props: { view, active: true, disabled: false }, global: { stubs: { Teleport: true } } });
  const picker = wrapper.get('[data-testid="image-model-picker-trigger"]');
  await picker.trigger('click');
  expect(wrapper.find('[data-testid="image-model-picker-popup"]').exists()).toBe(true);
  view.scanState.value = 'scanning'; await wrapper.vm.$nextTick();
  expect(picker.element.matches(':disabled')).toBe(true);
  expect(wrapper.find('[data-testid="image-model-picker-popup"]').exists()).toBe(false);
  expect(view.components.value[0]?.selected).toBe('selected-vae');
  view.scanState.value = 'idle'; await wrapper.vm.$nextTick();
  expect(picker.element.matches(':disabled')).toBe(false);
  expect(wrapper.find('[data-testid="image-model-picker-popup"]').exists()).toBe(false);
  wrapper.unmount();
});
