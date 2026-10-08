import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { useModelDownloadDestination } from './useModelDownloadDestination';
import type { ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination';

const state = vi.hoisted(() => ({ current: undefined as FileSystemDirectoryHandle | undefined, permission: vi.fn(), refresh: vi.fn(async () => {}) }));
vi.mock('@/composables/useHostModelDirectories', () => ({
  useHostModelDirectories: () => ({
    registrations: () => [{ id: 'root-a', name: 'Models' }],
    refresh: state.refresh,
    currentHandle: () => state.current,
    downloadDestination: state.permission,
    hostDownloadDestination: state.permission,
    view: { supported: computed(() => true), entries: computed(() => [{ id: 'root-a', name: 'Models', access: 'readwrite', error: undefined }]), busy: ref(false), destination: ref('opfs'), add: vi.fn(), reconnect: vi.fn(), remove: vi.fn(), selectDestination: vi.fn() },
  }),
}));
const wrappers: VueWrapper[] = [];
function create() {
  let destination: ReturnType<typeof useModelDownloadDestination> | undefined;
  const changed = vi.fn();
  const wrapper = mount(defineComponent({
    setup() {
      destination = useModelDownloadDestination({ blocked: () => false, changed }); return () => undefined;
    },
  }));
  wrappers.push(wrapper); return { destination: destination!, changed };
}

beforeEach(() => {
  vi.clearAllMocks(); state.current = undefined;
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe('download destination permission snapshots', () => {
  it('retains the exact cached handle captured before a permission prompt', async () => {
    const first = { kind: 'directory', name: 'First' } as FileSystemDirectoryHandle;
    const second = { kind: 'directory', name: 'Second' } as FileSystemDirectoryHandle;
    const permission = Promise.withResolvers<ModelDestination>();
    state.current = first; state.permission.mockReturnValue(permission.promise);
    const { destination } = create();
    const pending = destination.authorize({ destination: { kind: 'host', directoryId: 'root-a' } });
    expect(state.permission).toHaveBeenCalledWith({ id: 'root-a' });
    state.current = second;
    permission.resolve({ kind: 'host', directoryId: 'root-a' });
    expect(await pending).toEqual({ destination: { kind: 'host', directoryId: 'root-a' }, expectedRoot: first });
  });

  it('rejects a missing root without requesting permission or falling back', async () => {
    const { destination } = create();
    await expect(destination.authorize({ destination: { kind: 'host', directoryId: 'root-a' } })).rejects.toThrow('Reconnect');
    expect(state.permission).not.toHaveBeenCalled();
    expect(await destination.authorize({ destination: { kind: 'opfs' } })).toEqual({ destination: { kind: 'opfs' }, expectedRoot: undefined });
  });

  it('refreshes independent mounted sections after a shared registration permission change', async () => {
    const first = create(); const second = create(); await flushPromises();
    state.refresh.mockClear();
    window.dispatchEvent(new Event('naidan-host-model-directories-changed')); await flushPromises();
    expect(state.refresh).toHaveBeenCalledTimes(2);
    expect(first.changed).toHaveBeenCalledOnce(); expect(second.changed).toHaveBeenCalledOnce();
  });
});
