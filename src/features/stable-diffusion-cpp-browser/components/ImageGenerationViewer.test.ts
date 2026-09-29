import { afterEach, beforeEach, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationViewer from './ImageGenerationViewer.vue';
let wrapper: VueWrapper<InstanceType<typeof ImageGenerationViewer>> | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
});
it('supports explicit zoom, keyboard next/previous and closing without owning image storage', async () => {
  wrapper = mount(ImageGenerationViewer, { props: { downloadEnabled: true, count: 3, index: 0, 'onUpdate:index': value => wrapper?.setProps({ index: value }) }, global: { stubs: { Teleport: true } } });
  await wrapper.get('[data-testid="image-viewer-zoom-in"]').trigger('click');
  expect(wrapper.vm.TEST_ONLY.zoom.value).toBe(1.25);
  await wrapper.get('[data-testid="image-viewer"]').trigger('keydown', { key: 'ArrowRight' });
  expect(wrapper.props('index')).toBe(1);
  expect(wrapper.vm.TEST_ONLY.zoom.value).toBe(1);
  await wrapper.get('[data-testid="image-viewer"]').trigger('keydown', { key: 'ArrowLeft' });
  expect(wrapper.props('index')).toBe(0);
  expect(wrapper.get('[data-testid="image-viewer-previous"]').element.matches(':disabled')).toBe(true);
  await wrapper.get('[data-testid="image-viewer"]').trigger('keydown', { key: 'Escape' });
  expect(wrapper.emitted('close')).toHaveLength(1);
});

it('does not offer a PNG download for input images when the caller disables it', () => {
  wrapper = mount(ImageGenerationViewer, { props: { count: 1, index: 0, downloadEnabled: false }, global: { stubs: { Teleport: true } } });
  expect(wrapper.text()).not.toContain('Download PNG');
});
