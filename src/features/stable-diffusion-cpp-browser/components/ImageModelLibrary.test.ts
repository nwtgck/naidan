import { beforeEach, expect, it, vi } from 'vitest';
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
  const wrapper = mount(ImageModelLibrary, { props: { view, disabled: false } });
  expect(wrapper.get('[data-testid="image-inventory-progress"]').text()).toContain('3 / 7');
  expect(wrapper.text()).toContain('user/weights/model.gguf');
  await wrapper.get('[data-testid="image-cancel-scan"]').trigger('click');
  expect(view.cancelScan).toHaveBeenCalledOnce(); wrapper.unmount();
});
