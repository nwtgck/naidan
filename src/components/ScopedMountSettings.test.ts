import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { toChatGroupId, toChatId, toVolumeId } from '@/01-models/ids';
import type { Mount, Volume } from '@/01-models/types';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ScopedMountSettings, { type MountSettingsOwner } from './ScopedMountSettings.vue';
import VolumeCreator from './VolumeCreator.vue';
import type { SettingsSource } from '@/logic/settings-labels';

const mocks = vi.hoisted(() => ({
  listVolumes: vi.fn(),
  getVolumeDirectoryHandle: vi.fn(),
  chatAdd: vi.fn(),
  chatRemove: vi.fn(),
  chatUpdate: vi.fn(),
  chatGroupAdd: vi.fn(),
  chatGroupRemove: vi.fn(),
  chatGroupReadOnly: vi.fn(),
  openFileExplorer: vi.fn(),
  createVolume: vi.fn(),
  addToast: vi.fn(),
}));
vi.mock('@/00-storage/service', () => ({ storageService: { listVolumes: mocks.listVolumes, getVolumeDirectoryHandle: mocks.getVolumeDirectoryHandle, createVolume: mocks.createVolume } }));
vi.mock('@/composables/chat/useChatMounts', () => ({ useChatMounts: () => ({ addMount: mocks.chatAdd, removeMount: mocks.chatRemove, updateMount: mocks.chatUpdate }) }));
vi.mock('@/composables/chat/useChatGroupMounts', () => ({ useChatGroupMounts: () => ({ addMount: mocks.chatGroupAdd, removeMount: mocks.chatGroupRemove, setMountReadOnly: mocks.chatGroupReadOnly }) }));
vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({ useFileExplorerModal: () => ({ openFileExplorer: mocks.openFileExplorer }) }));
vi.mock('@/utils/opfs-detection', () => ({ checkOPFSSupport: async () => true, checkFileSystemAccessSupport: () => true }));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ addToast: mocks.addToast }) }));

function mountSettings({ owner, mounts, inheritedMounts }: {
  owner: MountSettingsOwner,
  mounts: Mount[],
  inheritedMounts: { mount: Mount, source: SettingsSource }[],
}) {
  const wrapper = mount(ScopedMountSettings, { props: { owner, mounts, inheritedMounts }, global: { stubs: { VolumeCreator: true } } });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

function folder({ name, readOnly }: { name: string, readOnly: boolean }): Mount {
  return { type: 'volume', volumeId: toVolumeId({ raw: name }), mountPath: `/home/user/${name}`, readOnly };
}

function metadata({ mount: entry, type }: { mount: Mount, type: Volume['type'] }): Volume {
  return { id: entry.volumeId, name: 'Documents', type, createdAt: 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const chatOwner = { type: 'chat', id: toChatId({ raw: 'chat-a' }) } as const;
const chatGroupOwner = { type: 'chat_group', id: toChatGroupId({ raw: 'chat-group-a' }) } as const;

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.listVolumes.mockImplementation(async function* () {});
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ScopedMountSettings', () => {
  it.each([chatOwner, chatGroupOwner])('denies read/write when metadata remains unknown for $type', async owner => {
    using view = mountSettings({ owner, mounts: [folder({ name: 'missing', readOnly: true })], inheritedMounts: [] });
    await flushPromises();
    await view.wrapper.get('[data-testid="mount-read-write"]').trigger('click');
    await flushPromises();
    expect(mocks.getVolumeDirectoryHandle).not.toHaveBeenCalled();
    expect(mocks.chatUpdate).not.toHaveBeenCalled();
    expect(mocks.chatGroupReadOnly).not.toHaveBeenCalled();
    expect(view.wrapper.get('[data-testid="mount-read-only"]').attributes('aria-pressed')).toBe('true');
    expect(view.wrapper.get('[role="alert"]').text()).not.toBe('');
  });

  it('does not save permission when the metadata refresh fails', async () => {
    mocks.listVolumes.mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error('Metadata unavailable');
          },
        };
      },
    });
    using view = mountSettings({ owner: chatOwner, mounts: [folder({ name: 'missing', readOnly: true })], inheritedMounts: [] });
    await flushPromises();
    await view.wrapper.get('[data-testid="mount-read-write"]').trigger('click');
    await flushPromises();
    expect(mocks.chatUpdate).not.toHaveBeenCalled();
    expect(view.wrapper.get('[role="alert"]').text()).toBe('Metadata unavailable');
  });

  it.each(['denied', 'prompt'] as const)('keeps host permission and mount unchanged for %s', async permission => {
    const entry = folder({ name: 'host', readOnly: true });
    mocks.listVolumes.mockImplementation(async function* () {
      yield metadata({ mount: entry, type: 'host' });
    });
    const requestPermission = vi.fn().mockResolvedValue(permission);
    mocks.getVolumeDirectoryHandle.mockResolvedValue({ requestPermission });
    using view = mountSettings({ owner: chatOwner, mounts: [entry], inheritedMounts: [] });
    await flushPromises();
    await view.wrapper.get('[data-testid="mount-read-write"]').trigger('click');
    await flushPromises();
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(mocks.chatUpdate).not.toHaveBeenCalled();
    expect(view.wrapper.get('[data-testid="mount-read-only"]').attributes('aria-pressed')).toBe('true');
  });

  it('serializes permission and removal and saves the captured owner after navigation', async () => {
    const entry = folder({ name: 'host', readOnly: true });
    mocks.listVolumes.mockImplementation(async function* () {
      yield metadata({ mount: entry, type: 'host' });
    });
    const permission = deferred<PermissionState>();
    const requestPermission = vi.fn(() => permission.promise);
    mocks.getVolumeDirectoryHandle.mockResolvedValue({ requestPermission });
    using view = mountSettings({ owner: chatGroupOwner, mounts: [entry], inheritedMounts: [] });
    await flushPromises();
    await view.wrapper.get('[data-testid="mount-read-write"]').trigger('click');
    await flushPromises();
    expect(view.wrapper.get('[data-testid="mount-remove"]').attributes('disabled')).toBeDefined();
    await view.wrapper.get('[data-testid="mount-remove"]').trigger('click');
    await view.wrapper.get('[data-testid="mount-read-write"]').trigger('click');
    expect(mocks.chatGroupRemove).not.toHaveBeenCalled();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await view.wrapper.setProps({ owner: { type: 'chat', id: toChatId({ raw: 'chat-b' }) }, mounts: [] });
    permission.resolve('granted');
    await flushPromises();
    expect(mocks.chatGroupReadOnly).toHaveBeenCalledWith({ chatGroupId: chatGroupOwner.id, volumeId: entry.volumeId, readOnly: false });
    expect(mocks.chatUpdate).not.toHaveBeenCalled();
    expect(view.wrapper.emitted('status')?.at(-1)?.[0]).toEqual({ pending: false, error: undefined });
  });

  it('does not expose a previous owner error in the next owner', async () => {
    const removal = deferred<void>();
    mocks.chatRemove.mockReturnValue(removal.promise);
    using view = mountSettings({ owner: chatOwner, mounts: [folder({ name: 'docs', readOnly: true })], inheritedMounts: [] });
    await view.wrapper.get('[data-testid="mount-remove"]').trigger('click');
    await view.wrapper.setProps({ owner: chatGroupOwner, mounts: [] });
    removal.reject(new Error('Old owner failed'));
    await flushPromises();
    expect(view.wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(view.wrapper.emitted('status')?.at(-1)?.[0]).toEqual({ pending: false, error: undefined });
  });

  it('does not request browser permission for a known OPFS volume', async () => {
    const entry = folder({ name: 'copy', readOnly: true });
    mocks.listVolumes.mockImplementation(async function* () {
      yield metadata({ mount: entry, type: 'opfs' });
    });
    using view = mountSettings({ owner: chatOwner, mounts: [entry], inheritedMounts: [] });
    await flushPromises();
    await view.wrapper.get('[data-testid="mount-read-write"]').trigger('click');
    await flushPromises();
    expect(mocks.getVolumeDirectoryHandle).not.toHaveBeenCalled();
    expect(mocks.chatUpdate).toHaveBeenCalledWith({ chatId: chatOwner.id, volumeId: entry.volumeId, readOnly: false });
  });

  it('passes only owner paths to creation and binds late completion to its original owner', async () => {
    const own = folder({ name: 'docs', readOnly: true });
    using view = mountSettings({ owner: chatOwner, mounts: [own], inheritedMounts: [{ mount: folder({ name: 'shared', readOnly: false }), source: 'global' }] });
    const creator = view.wrapper.getComponent(VolumeCreator);
    expect(creator.props('existingMountPaths')).toEqual([own.mountPath]);
    expect(creator.props('mountPathPrefix')).toBe('/home/user/');
    const operationContext = creator.props('operationContext');
    const complete = creator.props('completeCreation');
    if (!complete) {
      throw new Error('Expected a persistent creation callback');
    }
    await view.wrapper.setProps({ owner: chatGroupOwner, mounts: [] });
    await complete({ volumeId: own.volumeId, mountPath: own.mountPath, readOnly: false, operationContext });
    await flushPromises();
    expect(mocks.chatAdd).toHaveBeenCalledWith({ chatId: chatOwner.id, mount: { ...own, readOnly: false } });
    expect(mocks.chatGroupAdd).not.toHaveBeenCalled();
  });

  it('attaches a real creator result to its starting owner after owner change and unmount', async () => {
    const creation = deferred<Volume>();
    mocks.createVolume.mockReturnValue(creation.promise);
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue({ name: 'Documents' }));
    const wrapper = mount(ScopedMountSettings, { props: { owner: chatOwner, mounts: [], inheritedMounts: [] } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    await wrapper.get('[data-testid="add-folder-btn"]').trigger('click');
    document.querySelector<HTMLButtonElement>('[data-testid="add-folder-read-only-btn"]')!.click();
    await flushPromises();
    await wrapper.setProps({ owner: chatGroupOwner });
    wrapper.unmount();
    creation.resolve({ id: toVolumeId({ raw: 'new-host' }), name: 'Documents', type: 'host', createdAt: 0 });
    await flushPromises();
    expect(mocks.chatAdd).toHaveBeenCalledTimes(1);
    expect(mocks.chatAdd).toHaveBeenCalledWith({ chatId: chatOwner.id, mount: { type: 'volume', volumeId: toVolumeId({ raw: 'new-host' }), mountPath: '/home/user/documents', readOnly: true } });
    expect(mocks.chatGroupAdd).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('keeps attachment failures in status and suppresses the creation success toast', async () => {
    mocks.chatAdd.mockRejectedValue(new Error('Mount save failed'));
    mocks.createVolume.mockResolvedValue({ id: toVolumeId({ raw: 'new-host' }), name: 'Documents', type: 'host', createdAt: 0 });
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue({ name: 'Documents' }));
    const wrapper = mount(ScopedMountSettings, { props: { owner: chatOwner, mounts: [], inheritedMounts: [] } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    await wrapper.get('[data-testid="add-folder-btn"]').trigger('click');
    document.querySelector<HTMLButtonElement>('[data-testid="add-folder-read-only-btn"]')!.click();
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Mount save failed');
    expect(wrapper.emitted('status')?.at(-1)?.[0]).toEqual({ pending: false, error: 'Mount save failed' });
    expect(mocks.addToast).toHaveBeenCalledTimes(1);
    expect(mocks.addToast).toHaveBeenCalledWith({ message: expect.stringContaining('Mount save failed') });
  });

  it('lets a usable inherited folder return after removing a same-path local folder', async () => {
    const inherited = folder({ name: 'shared', readOnly: false });
    const own = { ...folder({ name: 'local', readOnly: true }), mountPath: inherited.mountPath };
    mocks.getVolumeDirectoryHandle.mockImplementation(async ({ volumeId }: { volumeId: Mount['volumeId'] }) => ({ name: String(volumeId) }));
    using view = mountSettings({ owner: chatOwner, mounts: [own], inheritedMounts: [{ mount: inherited, source: 'global' }] });
    await view.wrapper.get('[data-testid="mount-open"]').trigger('click');
    await flushPromises();
    expect(mocks.openFileExplorer).toHaveBeenLastCalledWith({ options: expect.objectContaining({ mounts: [expect.objectContaining({ path: inherited.mountPath, readOnly: true })] }) });
    await view.wrapper.get('[data-testid="mount-remove"]').trigger('click');
    await flushPromises();
    expect(mocks.chatRemove).toHaveBeenCalledWith({ chatId: chatOwner.id, volumeId: own.volumeId });
    await view.wrapper.setProps({ mounts: [] });
    await view.wrapper.get('[data-testid="inherited-mount-open"]').trigger('click');
    await flushPromises();
    expect(mocks.openFileExplorer).toHaveBeenLastCalledWith({ options: expect.objectContaining({ mounts: [expect.objectContaining({ path: inherited.mountPath, readOnly: false })] }) });
  });

  it('does not hide an available inherited entry behind a missing local handle', async () => {
    const inherited = folder({ name: 'shared', readOnly: false });
    const own = { ...folder({ name: 'local', readOnly: true }), mountPath: inherited.mountPath };
    mocks.getVolumeDirectoryHandle.mockImplementation(async ({ volumeId }: { volumeId: Mount['volumeId'] }) => volumeId === inherited.volumeId ? { name: 'upstream' } : undefined);
    using view = mountSettings({ owner: chatOwner, mounts: [own], inheritedMounts: [{ mount: inherited, source: 'global' }] });
    await view.wrapper.get('[data-testid="mount-open"]').trigger('click');
    await flushPromises();
    expect(mocks.openFileExplorer).toHaveBeenCalledWith({ options: expect.objectContaining({ mounts: [expect.objectContaining({ path: inherited.mountPath, readOnly: false })] }) });
  });

  it('preserves inherited read/write access without offering inherited mutations', async () => {
    const inherited = folder({ name: 'shared', readOnly: false });
    mocks.getVolumeDirectoryHandle.mockResolvedValue({ name: 'shared' });
    using view = mountSettings({ owner: chatOwner, mounts: [], inheritedMounts: [{ mount: inherited, source: 'global' }] });
    const row = view.wrapper.get('[data-testid="inherited-mount-row"]');
    expect(row.text()).toContain('Read and write');
    expect(row.find('[data-testid="mount-remove"]').exists()).toBe(false);
    expect(row.find('[data-testid="mount-read-write"]').exists()).toBe(false);
    await row.get('[data-testid="inherited-mount-open"]').trigger('click');
    await flushPromises();
    expect(mocks.openFileExplorer).toHaveBeenCalledWith({ options: expect.objectContaining({ initialPath: ['home', 'user', 'shared'], mounts: [expect.objectContaining({ path: inherited.mountPath, readOnly: false })] }) });
  });

  it('does not open an explorer after its owner component unmounts', async () => {
    const handle = deferred<FileSystemDirectoryHandle>();
    mocks.getVolumeDirectoryHandle.mockReturnValue(handle.promise);
    using view = mountSettings({ owner: chatOwner, mounts: [folder({ name: 'docs', readOnly: true })], inheritedMounts: [] });
    await view.wrapper.get('[data-testid="mount-open"]').trigger('click');
    view.wrapper.unmount();
    handle.resolve({ name: 'docs' } as FileSystemDirectoryHandle);
    await flushPromises();
    expect(mocks.openFileExplorer).not.toHaveBeenCalled();
  });
});
