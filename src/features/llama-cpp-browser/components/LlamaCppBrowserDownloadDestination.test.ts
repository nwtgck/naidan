import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { HostModelDirectoriesView, HostModelDirectoryChoice } from '@/composables/useHostModelDirectories';
import LlamaCppBrowserDownloadDestination from './LlamaCppBrowserDownloadDestination.vue';

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
  const wrapper = mount(LlamaCppBrowserDownloadDestination, { props: { view, disabled: false } });
  wrappers.push(wrapper); return { wrapper, view };
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe('compact linked-folder download controls', () => {
  it('keeps the unsupported choice visible with feature-detected reasons and management initially closed', () => {
    const { wrapper } = render({ supported: false, entries: [], destination: 'opfs' });
    const options = wrapper.get('[data-testid="llama-download-destination"]').findAll('option');
    expect(options.map(option => option.text())).toEqual(['Browser storage (OPFS)', 'Linked folder · Unavailable']);
    expect(options[1]!.attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="llama-host-folders-unavailable"]').text()).toContain('showDirectoryPicker');
    expect(wrapper.get('[data-testid="llama-add-model-directory"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="llama-model-directory-registrations"]').attributes('open')).toBeUndefined();
    expect(wrapper.get('[data-testid="llama-manage-model-directories"]').attributes('title')).toContain('showDirectoryPicker');
  });

  it('distinguishes unconfigured folders from registered folders needing permission', async () => {
    const empty = render({ supported: true, entries: [], destination: 'opfs' });
    expect(empty.wrapper.get('select').text()).toContain('Not linked');
    expect(empty.wrapper.get('[data-testid="llama-host-folders-unconfigured"]').text()).toContain('Link a folder');
    const { wrapper, view } = render({ supported: true, entries: [{ id: 'root-a', name: 'Models', access: 'prompt', error: undefined }], destination: 'root-a' });
    expect(wrapper.get('[data-testid="llama-host-folder-permission-root-a"]').text()).toBe('Permission expired; reconnect');
    await wrapper.get('[data-testid="llama-reconnect-model-directory-root-a"]').trigger('click');
    expect(view.reconnect).toHaveBeenCalledWith({ id: 'root-a' });
    await wrapper.get('[data-testid="llama-unregister-model-directory-root-a"]').trigger('click');
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
    expect(wrapper.get('select').text()).toContain('Models (root-a)');
    expect(wrapper.get('select').text()).toContain('Models (root-b)');
    expect(wrapper.get<HTMLSelectElement>('select').element.value).toBe('host:removed-root');
    expect(wrapper.get('[data-testid="llama-missing-download-destination"]').attributes('disabled')).toBeDefined();
    await wrapper.get('select').setValue('host:root-b');
    expect(view.selectDestination).toHaveBeenCalledWith({ id: 'root-b', kind: 'host' });
    expect(wrapper.get('[data-testid="llama-host-folder-layout"]').text()).toContain('subdir');
  });
});
