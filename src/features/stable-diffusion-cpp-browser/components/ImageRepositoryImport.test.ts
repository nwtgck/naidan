import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import ImageRepositoryImport from './ImageRepositoryImport.vue';
import { createDisabledImageLibrary } from '@/features/stable-diffusion-cpp-browser/library-standalone';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => vi.restoreAllMocks());

it('advertises copy while idle and none while busy; drop is not controlled by truthy Ref objects', async () => {
  const downloading = ref(false), importing = ref(false);
  const view = { ...createDisabledImageLibrary(), downloading: computed(() => downloading.value), importing: computed(() => importing.value), dropDirectory: vi.fn(async () => undefined) };
  const wrapper = mount(ImageRepositoryImport, { props: { view, disabled: false } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const zone = wrapper.get('[data-testid="image-repository-drop"]');
  const transfer = { dropEffect: 'none', types: ['Files'] };
  await zone.trigger('dragover', { dataTransfer: transfer });
  expect(transfer.dropEffect).toBe('copy');
  downloading.value = true;
  await zone.trigger('dragover', { dataTransfer: transfer });
  expect(transfer.dropEffect).toBe('none');
  await zone.trigger('drop', { dataTransfer: transfer });
  expect(view.dropDirectory).not.toHaveBeenCalled();
  downloading.value = false;
  await zone.trigger('drop', { dataTransfer: transfer });
  expect(view.dropDirectory).toHaveBeenCalledOnce();
  importing.value = true;
  await zone.trigger('dragover', { dataTransfer: transfer });
  expect(transfer.dropEffect).toBe('none');
});

it('keeps an active import cancellable when an independent operation blocks new imports', async () => {
  const view = { ...createDisabledImageLibrary(), importing: computed(() => true), cancelImport: vi.fn(), dropDirectory: vi.fn(async () => undefined) };
  const wrapper = mount(ImageRepositoryImport, { props: { view, disabled: true } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const cancel = wrapper.get<HTMLButtonElement>('[data-testid="image-cancel-import"]');
  expect(cancel.element.disabled).toBe(false);
  await cancel.trigger('click');
  expect(view.cancelImport).toHaveBeenCalledOnce();
  expect(wrapper.get<HTMLInputElement>('input[type="file"]').element.disabled).toBe(true);
  expect(view.dropDirectory).not.toHaveBeenCalled();
});

it('keeps standalone import actions disabled when no import can be in progress', () => {
  const wrapper = mount(ImageRepositoryImport, { props: { view: createDisabledImageLibrary(), disabled: true } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(wrapper.get<HTMLInputElement>('input[type="file"]').element.disabled).toBe(true);
  expect(wrapper.find('[data-testid="image-cancel-import"]').exists()).toBe(false);
});

it('keeps unsupported linking dimmed but selectable even while the editor disables file operations', async () => {
  const wrapper = mount(ImageRepositoryImport, { props: { view: createDisabledImageLibrary(), disabled: true } });
  using _cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  expect(wrapper.get('[data-testid="image-import-mode-opfs"]').attributes('aria-pressed')).toBe('true');
  const link = wrapper.get<HTMLButtonElement>('[data-testid="image-import-mode-host"]');
  expect(link.element.disabled).toBe(false);
  expect(link.classes()).toContain('opacity-50');
  expect(link.text()).toBe('Link folder');
  expect(link.attributes('aria-describedby')).toBeUndefined();
  await link.trigger('click');
  expect(link.attributes('aria-pressed')).toBe('true');
  expect(wrapper.find('input[type="file"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="linked-host-folder-layout"]').text()).toContain('owner/');
  expect(wrapper.get('[data-testid="linked-host-folder-layout"]').text()).toContain('subdir/');
  expect(wrapper.get<HTMLButtonElement>('[data-testid="linked-add-model-directory"]').element.disabled).toBe(true);
  expect(wrapper.get('[data-testid="linked-host-folders-unavailable"]').text()).toBe('Linking folders on your device is not available in this environment.');
  await wrapper.get('[data-testid="image-import-mode-temp"]').trigger('click');
  expect(wrapper.find('input[webkitdirectory]').exists()).toBe(true);
  expect(wrapper.get<HTMLInputElement>('input[accept=".gguf,.safetensors,.sft"]').element.disabled).toBe(true);
});

it('reuses folder add, reconnect and unregister with the existing editor and download ownership guards', async () => {
  const downloading = ref(false);
  const view = { ...createDisabledImageLibrary(), downloading: computed(() => downloading.value) };
  view.hostDirectories = {
    ...view.hostDirectories,
    supported: computed(() => true),
    entries: computed(() => [{ id: 'missing-a', name: 'models', access: 'missing' as const, error: undefined }, { id: 'available-b', name: 'models', access: 'readwrite' as const, error: undefined }]),
    add: vi.fn(async () => {}),
    reconnect: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  const wrapper = mount(ImageRepositoryImport, { props: { view, disabled: false } });
  using _cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  await wrapper.get('[data-testid="image-import-mode-host"]').trigger('click');
  expect(wrapper.get('[data-testid="linked-model-directory-missing-a"]').text()).toContain('Select the folder again');
  expect(wrapper.get('[data-testid="linked-model-directory-missing-a"]').text()).toContain('missing-a');
  expect(wrapper.text()).toContain('Unlinking keeps all files');
  const add = wrapper.get<HTMLButtonElement>('[data-testid="linked-add-model-directory"]');
  const reconnect = wrapper.get<HTMLButtonElement>('[data-testid="linked-reconnect-model-directory-missing-a"]');
  const remove = wrapper.get<HTMLButtonElement>('[data-testid="linked-unregister-model-directory-missing-a"]');
  await add.trigger('click');
  await reconnect.trigger('click');
  expect(view.hostDirectories.add).toHaveBeenCalledOnce();
  expect(view.hostDirectories.reconnect).toHaveBeenCalledWith({ id: 'missing-a' });
  downloading.value = true;
  await wrapper.vm.$nextTick();
  expect(add.element.disabled).toBe(true);
  expect(reconnect.element.disabled).toBe(true);
  expect(remove.element.disabled).toBe(false);
  await remove.trigger('click');
  expect(view.hostDirectories.remove).toHaveBeenCalledWith({ id: 'missing-a' });
  await wrapper.setProps({ disabled: true });
  expect(remove.element.disabled).toBe(true);
  await wrapper.setProps({ disabled: false });
  downloading.value = false;
  await wrapper.vm.$nextTick();
  expect(add.element.disabled).toBe(false);
  expect(reconnect.element.disabled).toBe(false);
});

it('captures the selected storage mode for a drop and hides loose-file operations in link mode', async () => {
  const view = { ...createDisabledImageLibrary(), dropDirectory: vi.fn(async () => {}), importFiles: vi.fn(async () => {}) };
  const wrapper = mount(ImageRepositoryImport, { props: { view, disabled: false } });
  using _cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  const zone = wrapper.get('[data-testid="image-repository-drop"]');
  const transfer = { types: ['Files'], files: [new File(['weights'], 'model.gguf')], items: [] };
  await zone.trigger('drop', { dataTransfer: transfer });
  expect(view.dropDirectory).toHaveBeenLastCalledWith(expect.objectContaining({ storage: 'opfs' }));
  await wrapper.get('[data-testid="image-import-mode-temp"]').trigger('click');
  await zone.trigger('drop', { dataTransfer: transfer });
  expect(view.dropDirectory).toHaveBeenLastCalledWith(expect.objectContaining({ storage: 'temp' }));
  await wrapper.get('input[accept=".gguf,.safetensors,.sft"]').trigger('change');
  expect(view.importFiles).toHaveBeenLastCalledWith(expect.objectContaining({ storage: 'temp' }));
  await wrapper.get('[data-testid="image-import-mode-host"]').trigger('click');
  await zone.trigger('drop', { dataTransfer: transfer });
  expect(view.dropDirectory).toHaveBeenCalledTimes(2);
  expect(wrapper.find('[data-testid="image-choose-files"]').exists()).toBe(false);
});
