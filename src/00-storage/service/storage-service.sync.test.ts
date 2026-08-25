import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageService } from './index';
import { SYNC_LOCK_KEY, LOCK_METADATA, LOCK_CHAT_CONTENT_PREFIX } from '@/constants';
import { toBinaryObjectId, toChatGroupId, toChatId, toVolumeId } from '@/01-models/ids';

// We mock the synchronizer to track calls to withLock and notify
const { mockWithLock, mockNotify, mockSubscribe } = vi.hoisted(() => ({
  mockWithLock: vi.fn().mockImplementation(({ fn }) => fn()),
  mockNotify: vi.fn(),
  mockSubscribe: vi.fn(),
}));

const mockAddErrorEvent = vi.fn();
const mockAddInfoEvent = vi.fn();
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the application event dependency with a storage service event API.
vi.mock('../../composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: mockAddErrorEvent,
    addInfoEvent: mockAddInfoEvent,
  }),
}));

vi.mock('./synchronizer', () => {
  return {
    StorageSynchronizer: class {
      withLock = mockWithLock;
      notify = mockNotify;
      subscribe = mockSubscribe;
    },
  };
});

// Mock providers to avoid real storage access
const mockProvider = {
  init: vi.fn().mockResolvedValue(undefined),
  saveChatMeta: vi.fn().mockResolvedValue(undefined),
  loadChatMeta: vi.fn().mockResolvedValue(null),
  saveChatContent: vi.fn().mockResolvedValue(undefined),
  loadChatContent: vi.fn().mockResolvedValue(null),
  deleteChat: vi.fn().mockResolvedValue(undefined),
  saveChatGroup: vi.fn().mockResolvedValue(undefined),
  loadChatGroup: vi.fn().mockResolvedValue(null),
  deleteChatGroup: vi.fn().mockResolvedValue(undefined),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  clearAll: vi.fn().mockResolvedValue(undefined),
  saveFile: vi.fn().mockResolvedValue(undefined),
  loadChat: vi.fn().mockResolvedValue(null),
  listChats: vi.fn().mockResolvedValue([]),
  listChatGroups: vi.fn().mockResolvedValue([]),
  hasVolumeMountReference: vi.fn().mockResolvedValue(false),
  getVolumeDirectoryHandle: vi.fn().mockResolvedValue(null),
  deleteVolume: vi.fn().mockResolvedValue(undefined),
  getSidebarStructure: vi.fn().mockResolvedValue([]),
  loadSettings: vi.fn().mockResolvedValue(null),
  getFile: vi.fn().mockResolvedValue(null),
  hasAttachments: vi.fn().mockResolvedValue(false),
  loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
  saveHierarchy: vi.fn().mockResolvedValue(undefined),
  dump: vi.fn(),
  restore: vi.fn(),
};

vi.mock('./local-storage', () => ({
  LocalStorageProvider: class {
    constructor() {
      return mockProvider;
    }
  },
}));

vi.mock('./opfs-storage', () => ({
  OPFSStorageProvider: class {
    constructor() {
      return mockProvider;
    }
  },
}));

describe('StorageService Synchronization Wrapper', () => {
  let service: StorageService;

  beforeEach(async () => {
    vi.resetAllMocks();

    // Restore default mock implementations after reset
    mockWithLock.mockImplementation(({ fn }) => fn());
    mockProvider.saveChatMeta.mockResolvedValue(undefined);
    mockProvider.loadChatMeta.mockResolvedValue(null);
    mockProvider.saveChatContent.mockResolvedValue(undefined);
    mockProvider.loadChatContent.mockResolvedValue(null);
    mockProvider.deleteChat.mockResolvedValue(undefined);
    mockProvider.saveChatGroup.mockResolvedValue(undefined);
    mockProvider.loadChatGroup.mockResolvedValue(null);
    mockProvider.deleteChatGroup.mockResolvedValue(undefined);
    mockProvider.saveSettings.mockResolvedValue(undefined);
    mockProvider.clearAll.mockResolvedValue(undefined);
    mockProvider.saveFile.mockResolvedValue(undefined);
    mockProvider.init.mockResolvedValue(undefined);
    mockProvider.loadSettings.mockResolvedValue(null);
    mockProvider.listChatGroups.mockResolvedValue([]);
    mockProvider.hasVolumeMountReference.mockResolvedValue(false);
    mockProvider.getVolumeDirectoryHandle.mockResolvedValue(null);
    mockProvider.deleteVolume.mockResolvedValue(undefined);

    service = new StorageService();
    await service.init({ type: 'local' });
  });

  it('should wrap deleteChat with lock and notify after success', async () => {
    await service.deleteChat({ id: toChatId({ raw: 'c1' }) });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: LOCK_METADATA,
    }));
    expect(mockProvider.deleteChat).toHaveBeenCalledWith({ id: 'c1' });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group', id: 'c1' }) });
  });

  it('should wrap updateChatGroup with lock and notify after success', async () => {
    const group = { id: 'g1' } as any;
    const updater = vi.fn().mockResolvedValue(group);
    await service.updateChatGroup({ id: toChatGroupId({ raw: 'g1' }), updater: updater });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: LOCK_METADATA,
    }));
    expect(updater).toHaveBeenCalled();
    expect(mockProvider.saveChatGroup).toHaveBeenCalledWith({ chatGroup: group });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group', id: 'g1' }) });
  });

  it('should wrap deleteChatGroup with lock and notify after success', async () => {
    await service.deleteChatGroup({ id: toChatGroupId({ raw: 'g1' }) });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: LOCK_METADATA,
    }));
    expect(mockProvider.deleteChatGroup).toHaveBeenCalledWith({ id: 'g1' });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group', id: 'g1' }) });
  });

  it('should wrap updateSettings with lock and notify after success', async () => {
    const settings = { endpoint: { type: 'openai', url: 'test' } } as any;
    const updater = vi.fn().mockResolvedValue(settings);
    await service.updateSettings({ updater: updater });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: SYNC_LOCK_KEY,
    }));
    expect(updater).toHaveBeenCalled();
    expect(mockProvider.saveSettings).toHaveBeenCalledWith({ settings });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'settings' }) });
  });

  it('should wrap clearAll with lock and notify migration', async () => {
    await service.clearAll();

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: SYNC_LOCK_KEY,
    }));
    expect(mockProvider.clearAll).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'migration' }) });
  });

  it('does not add a chat mount when its chat group already uses the same path', async () => {
    const chatId = toChatId({ raw: 'c1' });
    const groupId = toChatGroupId({ raw: 'g1' });
    const volumeId = toVolumeId({ raw: 'v1' });
    mockProvider.loadChatMeta.mockResolvedValue({ id: chatId, groupId, mounts: [] });
    mockProvider.loadSettings.mockResolvedValue({ mounts: [] });
    mockProvider.loadChatGroup.mockResolvedValue({
      id: groupId,
      mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'existing' }), mountPath: '/workspace', readOnly: false }],
    });
    mockWithLock.mockClear();
    mockProvider.saveChatMeta.mockClear();

    await expect(service.addMountToChatIfPathAvailable({
      chatId,
      mount: { type: 'volume', volumeId, mountPath: '/workspace', readOnly: false },
    })).resolves.toBe('path_occupied');

    expect(mockProvider.saveChatMeta).not.toHaveBeenCalled();
    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({ lockKey: LOCK_METADATA }));
    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({ lockKey: SYNC_LOCK_KEY }));
  });

  it('does not add a chat mount when global settings already use the same path', async () => {
    const chatId = toChatId({ raw: 'c1' });
    const volumeId = toVolumeId({ raw: 'v1' });
    mockProvider.loadChatMeta.mockResolvedValue({ id: chatId, mounts: [] });
    mockProvider.loadSettings.mockResolvedValue({
      mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'existing' }), mountPath: '/workspace', readOnly: false }],
    });
    mockProvider.saveChatMeta.mockClear();

    await expect(service.addMountToChatIfPathAvailable({
      chatId,
      mount: { type: 'volume', volumeId, mountPath: '/workspace', readOnly: false },
    })).resolves.toBe('path_occupied');

    expect(mockProvider.loadChatGroup).not.toHaveBeenCalled();
    expect(mockProvider.saveChatMeta).not.toHaveBeenCalled();
  });

  it('treats lexically equivalent inherited mount paths as occupied', async () => {
    const chatId = toChatId({ raw: 'c1' });
    const groupId = toChatGroupId({ raw: 'g1' });
    const volumeId = toVolumeId({ raw: 'v1' });
    mockProvider.loadChatMeta.mockResolvedValue({ id: chatId, groupId, mounts: [] });
    mockProvider.loadSettings.mockResolvedValue({ mounts: [] });
    mockProvider.loadChatGroup.mockResolvedValue({
      id: groupId,
      mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'existing' }), mountPath: '/workspace/./', readOnly: false }],
    });
    mockProvider.saveChatMeta.mockClear();

    await expect(service.addMountToChatIfPathAvailable({
      chatId,
      mount: { type: 'volume', volumeId, mountPath: '/workspace', readOnly: false },
    })).resolves.toBe('path_occupied');

    expect(mockProvider.saveChatMeta).not.toHaveBeenCalled();
  });

  it('atomically adds a chat mount when the effective path is unused', async () => {
    const chatId = toChatId({ raw: 'c1' });
    const volumeId = toVolumeId({ raw: 'v1' });
    mockProvider.loadChatMeta.mockResolvedValue({ id: chatId, mounts: [] });
    mockProvider.loadSettings.mockResolvedValue({ mounts: [] });
    mockProvider.saveChatMeta.mockClear();

    const mount = { type: 'volume' as const, volumeId, mountPath: '/workspace', readOnly: false };
    await expect(service.addMountToChatIfPathAvailable({ chatId, mount })).resolves.toBe('added');

    expect(mockProvider.saveChatMeta).toHaveBeenCalledWith({
      meta: expect.objectContaining({ mounts: [mount] }),
    });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group', id: 'c1' }) });
  });

  it('skips volume reference locks when a detached volume is not empty', async () => {
    const volumeId = toVolumeId({ raw: 'v1' });
    mockProvider.getVolumeDirectoryHandle.mockResolvedValue({
      async *values() {
        yield { kind: 'file', name: 'keep.txt' };
      },
    });
    mockWithLock.mockClear();

    await expect(service.deleteVolumeIfEmptyAndUnreferenced({ volumeId })).resolves.toBe('kept');

    expect(mockProvider.hasVolumeMountReference).not.toHaveBeenCalled();
    expect(mockProvider.deleteVolume).not.toHaveBeenCalled();
    expect(mockWithLock).not.toHaveBeenCalled();
  });

  it('rechecks volume references while holding metadata and settings locks before deletion', async () => {
    const volumeId = toVolumeId({ raw: 'v1' });
    const emptyHandle = { async *values() {} };
    mockProvider.getVolumeDirectoryHandle.mockResolvedValue(emptyHandle);
    mockProvider.loadSettings.mockResolvedValue({ mounts: [] });
    mockProvider.hasVolumeMountReference
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockWithLock.mockClear();

    await expect(service.deleteVolumeIfEmptyAndUnreferenced({ volumeId })).resolves.toBe('kept');

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({ lockKey: LOCK_METADATA }));
    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({ lockKey: SYNC_LOCK_KEY }));
    expect(mockProvider.deleteVolume).not.toHaveBeenCalled();
  });

  it('deletes an empty unreferenced volume after the locked final recheck', async () => {
    const volumeId = toVolumeId({ raw: 'v1' });
    mockProvider.getVolumeDirectoryHandle.mockResolvedValue({ async *values() {} });
    mockProvider.loadSettings.mockResolvedValue({ mounts: [] });
    mockWithLock.mockClear();

    await expect(service.deleteVolumeIfEmptyAndUnreferenced({ volumeId })).resolves.toBe('deleted');

    expect(mockProvider.deleteVolume).toHaveBeenCalledWith({ volumeId });
    expect(mockProvider.hasVolumeMountReference).toHaveBeenCalledTimes(2);
  });

  it('should wrap saveFile with lock but not notify (tied to chat)', async () => {
    const blob = new Blob(['test']);
    await service.saveFile({ blob, binaryObjectId: toBinaryObjectId({ raw: 'a1' }), name: 'test.txt' });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: LOCK_METADATA,
    }));
    expect(mockProvider.saveFile).toHaveBeenCalledWith({
      blob,
      binaryObjectId: 'a1',
      name: 'test.txt',
      mimeType: undefined,
    });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('should NOT notify if the operation inside lock fails', async () => {
    mockProvider.saveChatMeta.mockRejectedValue(new Error('Failed'));

    await expect(service.updateChatMeta({ id: toChatId({ raw: 'c1' }), updater: () => ({} as any) })).rejects.toThrow('Failed');

    expect(mockWithLock).toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('should trigger info events via callbacks from withLock', async () => {
    const meta = { id: 'c1' } as any;

    // Extract the callbacks passed to withLock
    await service.updateChatMeta({ id: toChatId({ raw: 'c1' }), updater: () => meta });
    const options = mockWithLock.mock.calls.find(([options]) => options?.lockKey === LOCK_METADATA)?.[0] as {
      onLockWait: () => void,
      onTaskSlow: () => void,
      onFinalize: () => void,
    };

    options.onLockWait();
    expect(mockAddInfoEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('busy') }));

    options.onTaskSlow();
    expect(mockAddInfoEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('longer than expected') }));

    options.onFinalize();
    expect(mockAddInfoEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('completed') }));
  });

  it('should notify migration after switchProvider with custom lock options', async () => {
    mockProvider.dump.mockImplementation(async function* () {});

    await service.switchProvider({ type: 'opfs' });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      notifyLockWaitAfterMs: 5000,
    }));
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'migration' }) });
  });

  it('should report generic storage error via addErrorEvent', async () => {
    const diskError = new Error('Disk full');
    mockProvider.saveChatMeta.mockRejectedValueOnce(diskError);

    await expect(service.updateChatMeta({ id: toChatId({ raw: 'c1' }), updater: () => ({} as any) })).rejects.toThrow(diskError);

    expect(mockAddErrorEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('An error occurred'),
      details: diskError,
    }));
  });

  // --- New Atomic APIs (Granular Locking) ---

  it('should wrap updateChatMeta with metadata lock and notify', async () => {
    const meta = { id: 'c1' } as any;
    const updater = vi.fn().mockResolvedValue(meta);
    await service.updateChatMeta({ id: toChatId({ raw: 'c1' }), updater: updater });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: LOCK_METADATA,
    }));
    expect(updater).toHaveBeenCalled();
    expect(mockProvider.saveChatMeta).toHaveBeenCalledWith({ meta });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group', id: 'c1' }) });
  });



  it('should preserve saved tool configs during ordinary chat meta updates regardless of the UI persistence mode', async () => {
    const meta = {
      id: 'c1',
      toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
    } as any;

    await service.updateChatMeta({ id: toChatId({ raw: 'c1' }), updater: () => meta });

    expect(mockProvider.saveChatMeta).toHaveBeenCalledWith({ meta });
    expect(mockProvider.loadSettings).not.toHaveBeenCalled();
  });

  it('should not gate restore snapshots by the tool config persistence setting', async () => {
    const snapshot = {
      structure: {
        settings: {
          experimental: {
            toolConfigPersistence: 'disabled',
          },
        },
        hierarchy: { items: [] },
        chatMetas: [{ id: 'c1', toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }] }],
        chatGroups: [],
      },
      contentStream: (async function* () {})(),
    } as any;

    await service.restore({ snapshot });

    expect(mockProvider.restore).toHaveBeenCalledWith({ snapshot });
  });

  it('should wrap updateChatContent with specific chat lock and notify', async () => {
    const content = { root: { items: [] } } as any;
    const updater = vi.fn().mockResolvedValue(content);
    await service.updateChatContent({ id: toChatId({ raw: 'c1' }), updater: updater });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: `${LOCK_CHAT_CONTENT_PREFIX}c1`,
    }));
    expect(updater).toHaveBeenCalled();
    expect(mockProvider.saveChatContent).toHaveBeenCalledWith({ id: 'c1', content });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_content', id: 'c1' }) });
  });

  it('should wrap updateHierarchy with metadata lock and notify', async () => {
    const updater = ({ current }: { current: any }) => current;
    await service.updateHierarchy({ updater: updater });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: LOCK_METADATA,
    }));
    expect(mockProvider.saveHierarchy).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group' }) });
  });
});
