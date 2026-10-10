import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { HostModelDirectoriesView, HostModelDirectoryChoice } from '@/features/stable-diffusion-cpp-browser/library-view';
import ImageHostModelDirectories from './ImageHostModelDirectories.vue';

let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

function createView({ supported, entries }: { supported: boolean, entries: HostModelDirectoryChoice[] }): HostModelDirectoriesView {
  const destination = ref('opfs');
  return {
    supported: computed(() => supported),
    entries: computed(() => entries),
    destination,
    busy: ref(false),
    add: vi.fn(async () => {}),
    reconnect: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    selectDestination: vi.fn(({ id }: { id: string }) => {
      destination.value = id;
    }),
  };
}

it('defaults to browser storage and keeps unsupported folder controls visible and disabled', () => {
  const view = createView({ supported: false, entries: [] });
  wrapper = mount(ImageHostModelDirectories, { props: { view, opfsSupported: true, disabled: false, mutationDisabled: false, downloading: false, layoutFile: undefined } });
  expect(wrapper.get<HTMLSelectElement>('[data-testid="image-download-destination"]').element.value).toBe('opfs');
  expect(wrapper.get<HTMLButtonElement>('[data-testid="image-add-model-directory"]').element.disabled).toBe(true);
  expect(wrapper.get('[data-testid="image-host-folders-unavailable"]').text()).toContain('unavailable');
  expect(wrapper.text()).toContain('Linked folder');
  expect(wrapper.find('[data-testid="image-host-folder-layout"]').exists()).toBe(false);
  expect(view.add).not.toHaveBeenCalled();
});

it('selects a registered root and shows its real repository-relative nested layout', async () => {
  const view = createView({ supported: true, entries: [{ id: 'root-a', name: 'my-image-models', access: 'readwrite', error: undefined }] });
  wrapper = mount(ImageHostModelDirectories, {
    props: {
      view,
      opfsSupported: true,
      disabled: false,
      mutationDisabled: false,
      downloading: false,
      layoutFile: { repository: 'example-owner/image-model', path: 'split_files/vae/model.safetensors' },
    },
  });
  await wrapper.get('[data-testid="image-download-destination"]').setValue('root-a');
  expect(view.selectDestination).toHaveBeenCalledWith({ id: 'root-a' });
  const preview = wrapper.get('[data-testid="image-host-folder-layout"] pre').text();
  expect(preview).toBe(`\
my-image-models/
└─ example-owner/
   └─ image-model/
      └─ split_files/
         └─ vae/
            └─ model.safetensors`);
  expect(preview).not.toContain('resolve/main');
  expect(preview).not.toContain('huggingface.co');
  await wrapper.get('[data-testid="image-add-model-directory"]').trigger('click');
  expect(view.add).toHaveBeenCalledOnce();
});

it('keeps missing registrations visible for reconnect and distinguishes them by ID', async () => {
  const view = createView({
    supported: true,
    entries: [
      { id: 'missing-a', name: 'models', access: 'missing', error: undefined },
      { id: 'available-b', name: 'models', access: 'readwrite', error: undefined },
    ],
  });
  wrapper = mount(ImageHostModelDirectories, { props: { view, opfsSupported: true, disabled: false, mutationDisabled: false, downloading: false, layoutFile: undefined } });
  expect(wrapper.get<HTMLOptionElement>('option[value="missing-a"]').element.disabled).toBe(true);
  expect(wrapper.get<HTMLOptionElement>('option[value="available-b"]').element.disabled).toBe(false);
  expect(wrapper.get('[data-testid="image-model-directory-missing-a"]').text()).toContain('Select the folder again');
  await wrapper.get('[data-testid="image-reconnect-model-directory-missing-a"]').trigger('click');
  expect(view.reconnect).toHaveBeenCalledWith({ id: 'missing-a' });
  await wrapper.get('[data-testid="image-download-destination"]').setValue('available-b');
  expect(wrapper.get('[data-testid="image-host-folder-layout"]').text()).toContain('Example folder and file names');
});

it('shows an unregistered restored destination instead of silently selecting OPFS', async () => {
  const view = createView({ supported: true, entries: [{ id: 'available-b', name: 'other-models', access: 'readwrite', error: undefined }] });
  view.destination.value = 'removed-a';
  wrapper = mount(ImageHostModelDirectories, { props: { view, opfsSupported: true, disabled: false, mutationDisabled: false, downloading: false, layoutFile: undefined } });
  const select = wrapper.get<HTMLSelectElement>('[data-testid="image-download-destination"]');
  expect(select.element.value).toBe('removed-a');
  const missing = wrapper.get<HTMLOptionElement>('[data-testid="image-missing-download-destination"]');
  expect(missing.element.disabled).toBe(true);
  expect(missing.text()).toContain('removed-a');
  expect(missing.text()).toContain('Folder unavailable');
  expect(wrapper.find('[data-testid="image-host-folder-layout"]').exists()).toBe(false);
  expect(view.selectDestination).not.toHaveBeenCalled();
  await select.setValue('opfs');
  expect(view.selectDestination).toHaveBeenLastCalledWith({ id: 'opfs' });
  expect(wrapper.find('[data-testid="image-missing-download-destination"]').exists()).toBe(false);
  view.destination.value = 'removed-a';
  await wrapper.vm.$nextTick();
  expect(select.element.value).toBe('removed-a');
  await select.setValue('available-b');
  expect(view.selectDestination).toHaveBeenLastCalledWith({ id: 'available-b' });
  expect(select.element.value).toBe('available-b');
});

it('allows the next download destination to change while unregister can cancel its owned write', async () => {
  const view = createView({ supported: true, entries: [{ id: 'root-a', name: 'models', access: 'readwrite', error: undefined }] });
  wrapper = mount(ImageHostModelDirectories, { props: { view, opfsSupported: true, disabled: false, mutationDisabled: false, downloading: true, layoutFile: undefined } });
  expect(wrapper.get<HTMLSelectElement>('[data-testid="image-download-destination"]').element.disabled).toBe(false);
  expect(wrapper.get<HTMLButtonElement>('[data-testid="image-add-model-directory"]').element.disabled).toBe(true);
  expect(wrapper.get<HTMLButtonElement>('[data-testid="image-reconnect-model-directory-root-a"]').element.disabled).toBe(true);
  expect(wrapper.get<HTMLButtonElement>('[data-testid="image-unregister-model-directory-root-a"]').element.disabled).toBe(false);
  expect(wrapper.text()).toContain('Unlinking keeps all files in the folder.');
  await wrapper.get('[data-testid="image-unregister-model-directory-root-a"]').trigger('click');
  expect(view.remove).toHaveBeenCalledWith({ id: 'root-a' });
  await wrapper.setProps({ disabled: true });
  expect(wrapper.get<HTMLButtonElement>('[data-testid="image-unregister-model-directory-root-a"]').element.disabled).toBe(true);
});

it('blocks host registration mutations while the editor is owned but still changes the next download destination', async () => {
  const view = createView({ supported: true, entries: [{ id: 'root-a', name: 'models', access: 'readwrite', error: undefined }] });
  wrapper = mount(ImageHostModelDirectories, { props: { view, opfsSupported: true, disabled: false, mutationDisabled: true, downloading: false, layoutFile: undefined } });
  const add = wrapper.get<HTMLButtonElement>('[data-testid="image-add-model-directory"]');
  const reconnect = wrapper.get<HTMLButtonElement>('[data-testid="image-reconnect-model-directory-root-a"]');
  const remove = wrapper.get<HTMLButtonElement>('[data-testid="image-unregister-model-directory-root-a"]');
  expect(add.element.disabled).toBe(true);
  expect(reconnect.element.disabled).toBe(true);
  expect(remove.element.disabled).toBe(true);
  await add.trigger('click'); await reconnect.trigger('click'); await remove.trigger('click');
  expect(view.add).not.toHaveBeenCalled(); expect(view.reconnect).not.toHaveBeenCalled(); expect(view.remove).not.toHaveBeenCalled();
  const destination = wrapper.get<HTMLSelectElement>('[data-testid="image-download-destination"]');
  expect(destination.element.disabled).toBe(false);
  await destination.setValue('root-a');
  expect(view.selectDestination).toHaveBeenCalledWith({ id: 'root-a' });
  await wrapper.setProps({ mutationDisabled: false });
  expect(add.element.disabled).toBe(false); expect(reconnect.element.disabled).toBe(false); expect(remove.element.disabled).toBe(false);
});
