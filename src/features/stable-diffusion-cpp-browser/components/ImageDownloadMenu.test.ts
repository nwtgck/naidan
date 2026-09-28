import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { h, ref } from 'vue';
import ImageGenerationViewer from './ImageGenerationViewer.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageDownloadMenu from './ImageDownloadMenu.vue';
import type { ImageDownloadPreferences } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
});
function openMenu({ onDownload }: { onDownload: InstanceType<typeof ImageDownloadMenu>['$props']['onDownload'] }): VueWrapper {
  const preferences = ref<ImageDownloadPreferences>({ format: 'png', metadata: 'omit' });
  wrapper = mount(ImageDownloadMenu, { props: { active: true, disabled: false, preferences, onPreferencesChange: ({ preferences: next }) => {
    preferences.value = { ...next };
  }, onDownload }, global: { stubs: { Teleport: true } } });
  return wrapper;
}
it('defaults to plain PNG and explicitly selects a format and metadata per image', async () => {
  const onDownload = vi.fn(async () => ({ status: 'downloaded' as const }));
  const ui = openMenu({ onDownload });
  expect(ui.find('[data-testid="image-download-metadata"]').exists()).toBe(false);
  await ui.get('[data-testid="image-download-default"]').trigger('click'); await flushPromises();
  expect(onDownload).toHaveBeenLastCalledWith({ format: 'png', includeMetadata: false });
  await ui.get('[data-testid="image-download-options"]').trigger('click');
  await ui.get('[data-testid="image-download-format"]').setValue('webp');
  await ui.get('[data-testid="image-download-metadata"]').setValue(true);
  await ui.get('[data-testid="image-download-confirm"]').trigger('click'); await flushPromises();
  expect(onDownload).toHaveBeenLastCalledWith({ format: 'webp', includeMetadata: true });
  expect(ui.find('[data-testid="image-download-panel"]').exists()).toBe(false);
  await ui.get('[data-testid="image-download-options"]').trigger('click');
  await ui.get('[data-testid="image-download-format"]').setValue('jpeg');
  await ui.get('[data-testid="image-download-confirm"]').trigger('click'); await flushPromises();
  expect(onDownload).toHaveBeenLastCalledWith({ format: 'jpeg', includeMetadata: true });
});
it('uses restored preferences without writing them back and saves only explicit changes', async () => {
  const preferences = ref<ImageDownloadPreferences>({ format: 'jpeg', metadata: 'include' });
  const onPreferencesChange = vi.fn(({ preferences: next }: { preferences: ImageDownloadPreferences }) => {
    preferences.value = { ...next };
  });
  const onDownload = vi.fn(async () => ({ status: 'downloaded' as const }));
  wrapper = mount(ImageDownloadMenu, { props: { active: true, disabled: false, preferences, onPreferencesChange, onDownload }, global: { stubs: { Teleport: true } } });
  expect(wrapper.get('[data-testid="image-download-default"]').text()).toContain('JPEG');
  expect(onPreferencesChange).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="image-download-default"]').trigger('click');
  expect(onDownload).toHaveBeenCalledWith({ format: 'jpeg', includeMetadata: true });
  expect(onPreferencesChange).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="image-download-options"]').trigger('click');
  await wrapper.get('[data-testid="image-download-format"]').setValue('webp');
  expect(onPreferencesChange).toHaveBeenLastCalledWith({ preferences: { format: 'webp', metadata: 'include' } });
  await wrapper.get('[data-testid="image-download-metadata"]').setValue(false);
  expect(onPreferencesChange).toHaveBeenLastCalledWith({ preferences: { format: 'webp', metadata: 'omit' } });
});
it('shows busy and failure beside the action without losing the requested metadata', async () => {
  const pending = Promise.withResolvers<{ status: 'failed', message: string }>();
  const onDownload = vi.fn(() => pending.promise);
  const ui = openMenu({ onDownload });
  await ui.get('[data-testid="image-download-options"]').trigger('click');
  await ui.get('[data-testid="image-download-metadata"]').setValue(true);
  await ui.get('[data-testid="image-download-confirm"]').trigger('click');
  expect(ui.get('[data-testid="image-download-confirm"]').element.matches(':disabled')).toBe(true);
  pending.resolve({ status: 'failed', message: 'JPEG metadata is too large. Choose PNG or WebP.' });
  await flushPromises();
  expect(ui.get('[data-testid="image-download-error"]').text()).toContain('Choose PNG or WebP');
  expect((ui.get('[data-testid="image-download-metadata"]').element as HTMLInputElement).checked).toBe(true);
  expect(ui.get('[data-testid="image-download-confirm"]').element.matches(':disabled')).toBe(false);
});
it('closes on Escape, pane changes, and outside pointer events without downloading', async () => {
  const onDownload = vi.fn(async () => ({ status: 'downloaded' as const }));
  const ui = openMenu({ onDownload });
  await ui.get('[data-testid="image-download-options"]').trigger('click');
  await ui.get('[data-testid="image-download-panel"]').trigger('keydown', { key: 'Escape' });
  expect(ui.find('[data-testid="image-download-panel"]').exists()).toBe(false);
  await ui.get('[data-testid="image-download-options"]').trigger('click');
  await ui.get('[data-testid="image-download-panel"]').trigger('scroll');
  expect(ui.find('[data-testid="image-download-panel"]').exists()).toBe(true);
  window.dispatchEvent(new Event('resize')); await flushPromises();
  expect(ui.find('[data-testid="image-download-panel"]').exists()).toBe(false);
  await ui.get('[data-testid="image-download-options"]').trigger('click');
  await ui.setProps({ active: false });
  expect(ui.find('[data-testid="image-download-panel"]').exists()).toBe(false);
  await ui.setProps({ active: true });
  await ui.get('[data-testid="image-download-options"]').trigger('click');
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); await flushPromises();
  expect(ui.find('[data-testid="image-download-panel"]').exists()).toBe(false);
  expect(onDownload).not.toHaveBeenCalled();
});
it('handles rejected and cancelled operations without a false success or unhandled rejection', async () => {
  const ui = openMenu({ onDownload: async () => {
    throw new Error('Encode failed');
  } });
  await ui.get('[data-testid="image-download-default"]').trigger('click'); await flushPromises();
  expect(ui.get('[data-testid="image-download-error"]').text()).toBe('Encode failed');
  await ui.setProps({ onDownload: async () => ({ status: 'cancelled' }) });
  await ui.get('[data-testid="image-download-confirm"]').trigger('click'); await flushPromises();
  expect(ui.find('[data-testid="image-download-error"]').exists()).toBe(false);
  await ui.setProps({ disabled: true });
  expect(ui.get('[data-testid="image-download-default"]').element.matches(':disabled')).toBe(true);
  expect(ui.find('[data-testid="image-download-panel"]').exists()).toBe(false);
});

it('keeps Escape and Tab inside download options opened from the image viewer', async () => {
  const onClose = vi.fn();
  wrapper = mount(ImageGenerationViewer, {
    props: { downloadEnabled: true, index: 0, count: 2, onClose }, attachTo: document.body,
    slots: { download: () => h(ImageDownloadMenu, { active: true, disabled: false, preferences: ref<ImageDownloadPreferences>({ format: 'png', metadata: 'omit' }), onPreferencesChange: () => {}, onDownload: async () => ({ status: 'downloaded' as const }) }) },
  });
  const options = document.querySelector<HTMLButtonElement>('[data-testid="image-download-options"]')!;
  options.click(); await flushPromises();
  const panel = document.querySelector<HTMLElement>('[data-testid="image-download-panel"]')!;
  expect(document.activeElement).toBe(panel);
  panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(document.querySelector('[data-testid="image-download-confirm"]'));
  panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await flushPromises();
  expect(onClose).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="image-download-panel"]')).toBeNull();
  expect(document.activeElement).toBe(options);
});
