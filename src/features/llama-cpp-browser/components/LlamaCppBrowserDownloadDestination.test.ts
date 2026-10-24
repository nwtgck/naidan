import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { HostModelDirectoriesView, HostModelDirectoryChoice } from '@/composables/useHostModelDirectories';
import LlamaCppBrowserDownloadDestination from './LlamaCppBrowserDownloadDestination.vue';
import { downloadDestinationControl } from './model-configuration.test-support';

const wrappers: VueWrapper[] = [];

function render({ supported, entries, destination }: { supported: boolean, entries: HostModelDirectoryChoice[], destination: string }) {
  const selected = ref(destination);
  const view: HostModelDirectoriesView = {
    supported: computed(() => supported),
    entries: computed(() => entries),
    busy: ref(false),
    destination: selected,
    add: vi.fn(async () => {}),
    reconnect: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    selectDestination: vi.fn(({ id }: { id: string }) => {
      selected.value = id;
    }),
  };
  const wrapper = mount(LlamaCppBrowserDownloadDestination, { attachTo: document.body, props: { view, disabled: false } });
  wrappers.push(wrapper);
  return { wrapper, view };
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
});

describe('compact linked-folder download controls', () => {
  it('keeps the unsupported choice visible with a plain explanation and management initially closed', () => {
    const { wrapper } = render({ supported: false, entries: [], destination: 'opfs' });
    expect(downloadDestinationControl({ view: wrapper }).props('options')).toEqual([
      { value: 'opfs', label: 'Browser storage (OPFS)', detail: undefined, disabled: false },
      { value: '', label: 'Linked folder', detail: 'Unavailable', disabled: true },
    ]);
    expect(wrapper.get('[data-testid="linked-host-folders-unavailable"]').text()).toBe('Linking folders on your device is not available in this environment.');
    expect(wrapper.get('[data-testid="linked-add-model-directory"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="llama-manage-model-directories"]').attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[data-testid="llama-model-directory-registrations"]').attributes('inert')).toBeDefined();
    expect(wrapper.get('[data-testid="llama-manage-model-directories"]').attributes('title')).toBe('Linking folders on your device is not available in this environment.');
  });

  it('distinguishes unconfigured folders from registered folders needing permission', async () => {
    const empty = render({ supported: true, entries: [], destination: 'opfs' });
    expect(downloadDestinationControl({ view: empty.wrapper }).props('options')).toContainEqual(expect.objectContaining({ value: '', detail: 'Not linked', disabled: true }));
    expect(empty.wrapper.get('[data-testid="linked-host-folders-description"]').text()).toContain('Use model files directly');
    const { wrapper, view } = render({ supported: true, entries: [{ id: 'root-a', name: 'Models', access: 'prompt', error: undefined }], destination: 'root-a' });
    await wrapper.get('[data-testid="llama-manage-model-directories"]').trigger('click');
    expect(wrapper.get('[data-testid="linked-host-folder-permission-root-a"]').text()).toBe('Permission expired; reconnect');
    await wrapper.get('[data-testid="linked-reconnect-model-directory-root-a"]').trigger('click');
    expect(view.reconnect).toHaveBeenCalledWith({ id: 'root-a' });
    await wrapper.get('[data-testid="linked-unregister-model-directory-root-a"]').trigger('click');
    expect(view.remove).toHaveBeenCalledWith({ id: 'root-a' });
    expect(wrapper.text()).toContain('Unlinking keeps all files');
  });

  it('disambiguates equal basenames and preserves an unavailable selected root without falling back', async () => {
    const { wrapper, view } = render({
      supported: true,
      entries: [
        { id: 'root-a', name: 'Models', access: 'readwrite', error: undefined },
        { id: 'root-b', name: 'Models', access: 'readwrite', error: undefined },
      ],
      destination: 'removed-root',
    });
    const select = downloadDestinationControl({ view: wrapper });
    expect(select.props('options')).toContainEqual(expect.objectContaining({ value: 'host:root-a', label: 'Models (root-a)' }));
    expect(select.props('options')).toContainEqual(expect.objectContaining({ value: 'host:root-b', label: 'Models (root-b)' }));
    expect(select.props('modelValue')).toBe('host:removed-root');
    expect(select.props('options')).toContainEqual(expect.objectContaining({ value: 'host:removed-root', disabled: true }));
    await select.setValue('host:root-b');
    expect(view.selectDestination).toHaveBeenCalledWith({ id: 'root-b', kind: 'host' });
    expect(wrapper.get('[data-testid="linked-host-folder-layout"]').text()).toContain('subdir');
  });

  it('keeps opening either control separate from linking or selecting a destination', async () => {
    const { wrapper, view } = render({ supported: true, entries: [{ id: 'root-a', name: 'Models', access: 'prompt', error: undefined }], destination: 'opfs' });
    await wrapper.get('[data-testid="llama-manage-model-directories"]').trigger('click');
    expect(wrapper.get('[data-testid="llama-model-directory-registrations"]').attributes('inert')).toBeUndefined();
    expect(view.add).not.toHaveBeenCalled();
    const select = downloadDestinationControl({ view: wrapper });
    await select.get('button').trigger('click');
    await flushPromises();
    const hostOption = document.querySelector<HTMLButtonElement>('[data-testid="settings-select-option-host:root-a"]')!;
    expect(hostOption.textContent).toContain('Models');
    expect(hostOption.textContent).toContain('Permission expired; reconnect');
    expect(hostOption.disabled).toBe(false);
    expect(view.selectDestination).not.toHaveBeenCalled();
    expect(view.reconnect).not.toHaveBeenCalled();
    hostOption.click();
    await flushPromises();
    expect(view.selectDestination).toHaveBeenCalledWith({ id: 'root-a', kind: 'host' });
    expect(select.props('modelValue')).toBe('host:root-a');
    expect(document.activeElement).toBe(select.get('button').element);
    expect(select.get('button').attributes('aria-expanded')).toBe('false');
    expect(view.reconnect).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="linked-add-model-directory"]').trigger('click');
    expect(view.add).toHaveBeenCalledOnce();
  });

  it('blocks synthetic selection of inaccessible folders and changes while busy or disabled', async () => {
    const { wrapper, view } = render({ supported: true, entries: [{ id: 'root-a', name: 'Models', access: 'missing', error: undefined }], destination: 'opfs' });
    const select = downloadDestinationControl({ view: wrapper });
    await select.setValue('host:root-a');
    expect(view.selectDestination).not.toHaveBeenCalled();
    view.busy.value = true;
    await select.setValue('opfs');
    expect(view.selectDestination).not.toHaveBeenCalled();
    view.busy.value = false;
    await wrapper.setProps({ disabled: true });
    await select.setValue('opfs');
    expect(view.selectDestination).not.toHaveBeenCalled();
    expect(select.get('button').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="linked-add-model-directory"]').attributes('disabled')).toBeDefined();
  });
});
