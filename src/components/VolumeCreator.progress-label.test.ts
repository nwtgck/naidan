import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { registerStringBoundary, TEST_ONLY as stringsRuntime } from '@/strings/runtime';
import VolumeCreator from './VolumeCreator.vue';

vi.mock('@/00-storage/service', () => ({ storageService: {} }));
vi.mock('@/utils/opfs-detection', () => ({ checkOPFSSupport: async () => true, checkFileSystemAccessSupport: () => true }));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(['host', 'copy'] as const)('updates a pending %s operation label after its real string boundary loads', async kind => {
  const ready = Promise.withResolvers<void>();
  const boundaries = [...stringsRuntime.boundaryRegistrations.values()].filter(entry => entry.keys.includes('volumes__add_folder') || entry.keys.includes('volumes__copying_folder_to_browser'));
  expect(boundaries.length).toBeGreaterThan(0);
  using _restore = {
    [Symbol.dispose]() {
      for (const entry of boundaries) {
        registerStringBoundary(entry);
      }
    },
  };
  for (const entry of boundaries) {
    const load = async () => {
      await ready.promise;
      return entry.loaders.en();
    };
    registerStringBoundary({ boundaryId: entry.boundaryId, keys: entry.keys, loaders: { en: load, ja: load, 'zh-Hans': load, 'pt-BR': load, es: load, ko: load, de: load } });
  }
  const picker = vi.fn(() => new Promise<FileSystemDirectoryHandle>(() => {}));
  vi.stubGlobal('showDirectoryPicker', picker);
  const wrapper = mount(VolumeCreator, { props: { operationContext: 'chat:pending', existingMountPaths: [], mountPathPrefix: '/home/user/' } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await flushPromises();
  switch (kind) {
  case 'host':
    await wrapper.get('[data-testid="add-folder-btn"]').trigger('click');
    document.querySelector<HTMLButtonElement>('[data-testid="add-folder-read-only-btn"]')!.click();
    break;
  case 'copy': await wrapper.get('[data-testid="copy-folder-btn"]').trigger('click');
    break;
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled creation kind: ${_ex}`);
  }
  }
  await flushPromises();
  expect(picker).toHaveBeenCalledTimes(1);
  expect(wrapper.get('[data-testid="copy-progress"]').text()).toBe('');
  ready.resolve();
  await vi.waitFor(() => {
    expect(wrapper.get('[data-testid="copy-progress"]').text()).toContain(kind === 'host' ? 'Add Folder' : 'Copying folder to browser');
  });
  expect(picker).toHaveBeenCalledTimes(1);
});
