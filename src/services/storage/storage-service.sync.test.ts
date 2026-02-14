import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageService } from './index';
import { SYNC_LOCK_KEY, LOCK_METADATA, LOCK_CHAT_CONTENT_PREFIX } from '../../models/constants';

// We mock the synchronizer to track calls to withLock and notify
const { mockWithLock, mockNotify, mockSubscribe } = vi.hoisted(() => ({
  mockWithLock: vi.fn().mockImplementation((fn, _options) => fn()),
  mockNotify: vi.fn(),
  mockSubscribe: vi.fn(),
}));

const mockAddErrorEvent = vi.fn();
const mockAddInfoEvent = vi.fn();
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
    }
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
    mockWithLock.mockImplementation((fn, _options) => fn());
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

    service = new StorageService();
    await service.init('local');
  });

  it('should wrap deleteChat with lock and notify after success', async () => {
    await service.deleteChat('c1');

    expect(mockWithLock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      lockKey: LOCK_METADATA,
    }));
    expect(mockProvider.deleteChat).toHaveBeenCalledWith('c1');
    expect(mockNotify).toHaveBeenCalledWith('chat_meta_and_chat_group', 'c1');
  });

  it('should wrap updateChatGroup with lock and notify after success', async () => {
    const group = { id: 'g1' } as any;
    const updater = vi.fn().mockResolvedValue(group);
    await service.updateChatGroup('g1', updater);

    expect(mockWithLock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      lockKey: LOCK_METADATA,
    }));
    expect(updater).toHaveBeenCalled();
    expect(mockProvider.saveChatGroup).toHaveBeenCalledWith(group);
    expect(mockNotify).toHaveBeenCalledWith('chat_meta_and_chat_group', 'g1');
  });

  it('should wrap deleteChatGroup with lock and notify after success', async () => {
    await service.deleteChatGroup('g1');

    expect(mockWithLock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      lockKey: LOCK_METADATA,
    }));
    expect(mockProvider.deleteChatGroup).toHaveBeenCalledWith('g1');
    expect(mockNotify).toHaveBeenCalledWith('chat_meta_and_chat_group', 'g1');
  });

  it('should wrap updateSettings with lock and notify after success', async () => {
    const settings = { endpointUrl: 'test' } as any;
    const updater = vi.fn().mockResolvedValue(settings);
    await service.updateSettings(updater);

    expect(mockWithLock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      lockKey: SYNC_LOCK_KEY,
    }));
    expect(updater).toHaveBeenCalled();
    expect(mockProvider.saveSettings).toHaveBeenCalledWith(settings);
    expect(mockNotify).toHaveBeenCalledWith('settings');
  });

  it('should wrap clearAll with lock and notify migration', async () => {
    await service.clearAll();

    expect(mockWithLock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      lockKey: SYNC_LOCK_KEY,
    }));
    expect(mockProvider.clearAll).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith('migration');
  });

  it('should wrap saveFile with lock but not notify (tied to chat)', async () => {
    const blob = new Blob(['test']);
    await service.saveFile(blob, 'a1', 'test.txt');

    expect(mockWithLock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      lockKey: LOCK_METADATA,
    }));
    expect(mockProvider.saveFile).toHaveBeenCalledWith(blob, 'a1', 'test.txt');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('should NOT notify if the operation inside lock fails', async () => {
    mockProvider.saveChatMeta.mockRejectedValue(new Error('Failed'));

    await expect(service.updateChatMeta('c1', () => ({} as any))).rejects.toThrow('Failed');

    expect(mockWithLock).toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('should trigger info events via callbacks from withLock', async () => {
    const meta = { id: 'c1' } as any;

    // Extract the callbacks passed to withLock
    await service.updateChatMeta('c1', () => meta);
    const options = mockWithLock.mock.calls[0]?.[1];

    options.onLockWait();
    expect(mockAddInfoEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('busy') }));

    options.onTaskSlow();
    expect(mockAddInfoEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('longer than expected') }));

    options.onFinalize();
    expect(mockAddInfoEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('completed') }));
  });

  it('should notify migration after switchProvider with custom lock options', async () => {
    mockProvider.dump.mockImplementation(async function* () {});

    await service.switchProvider('opfs');

    expect(mockWithLock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      notifyLockWaitAfterMs: 5000,
    }));
    expect(mockNotify).toHaveBeenCalledWith('migration');
  });

  it('should report generic storage error via addErrorEvent', async () => {
    const diskError = new Error('Disk full');
    mockProvider.saveChatMeta.mockRejectedValueOnce(diskError);

    await expect(service.updateChatMeta('c1', () => ({} as any))).rejects.toThrow(diskError);

    expect(mockAddErrorEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('An error occurred'),
      details: diskError,
    }));
  });

  // --- New Atomic APIs (Granular Locking) ---

  it('should wrap updateChatMeta with metadata lock and notify', async () => {
    const meta = { id: 'c1' } as any;
    const updater = vi.fn().mockResolvedValue(meta);
    await service.updateChatMeta('c1', updater);

    expect(mockWithLock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      lockKey: LOCK_METADATA,
    }));
    expect(updater).toHaveBeenCalled();
    expect(mockProvider.saveChatMeta).toHaveBeenCalledWith(meta);
    expect(mockNotify).toHaveBeenCalledWith('chat_meta_and_chat_group', 'c1');
  });

  it('should wrap updateChatContent with specific chat lock and notify', async () => {
    const content = { root: { items: [] } } as any;
    const updater = vi.fn().mockResolvedValue(content);
    await service.updateChatContent('c1', updater);

    expect(mockWithLock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      lockKey: `${LOCK_CHAT_CONTENT_PREFIX}c1`,
    }));
    expect(updater).toHaveBeenCalled();
    expect(mockProvider.saveChatContent).toHaveBeenCalledWith('c1', content);
    expect(mockNotify).toHaveBeenCalledWith('chat_content', 'c1');
  });

  it('should wrap updateHierarchy with metadata lock and notify', async () => {
    const updater = (h: any) => h;
    await service.updateHierarchy(updater);

    expect(mockWithLock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      lockKey: LOCK_METADATA,
    }));
    expect(mockProvider.saveHierarchy).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith('chat_meta_and_chat_group');
  });
});