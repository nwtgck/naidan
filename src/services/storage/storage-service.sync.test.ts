import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageService } from './index';

// We mock the synchronizer to track calls to withLock and notify
const { mockWithLock, mockNotify, mockSubscribe } = vi.hoisted(() => ({
  mockWithLock: vi.fn().mockImplementation((fn) => fn()),
  mockNotify: vi.fn(),
  mockSubscribe: vi.fn(),
}));

const mockAddErrorEvent = vi.fn();
vi.mock('../../composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: mockAddErrorEvent,
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
  saveChat: vi.fn().mockResolvedValue(undefined),
  deleteChat: vi.fn().mockResolvedValue(undefined),
  saveChatGroup: vi.fn().mockResolvedValue(undefined),
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
  dump: vi.fn(),
  restore: vi.fn(),
};

vi.mock('./local-storage', () => ({
  LocalStorageProvider: class {
    constructor() { return mockProvider; }
  },
}));

vi.mock('./opfs-storage', () => ({
  OPFSStorageProvider: class {
    constructor() { return mockProvider; }
  },
}));

describe('StorageService Synchronization Wrapper', () => {
  let service: StorageService;

  beforeEach(async () => {
    vi.clearAllMocks();
    service = new StorageService();
    await service.init('local');
  });

  it('should wrap saveChat with lock and notify after success', async () => {
    const chat = { id: 'c1' } as any;
    await service.saveChat(chat, 0);

    expect(mockWithLock).toHaveBeenCalled();
    expect(mockProvider.saveChat).toHaveBeenCalledWith(chat, 0);
    expect(mockNotify).toHaveBeenCalledWith('chat', 'c1');
  });

  it('should wrap deleteChat with lock and notify after success', async () => {
    await service.deleteChat('c1');

    expect(mockWithLock).toHaveBeenCalled();
    expect(mockProvider.deleteChat).toHaveBeenCalledWith('c1');
    expect(mockNotify).toHaveBeenCalledWith('chat', 'c1');
  });

  it('should wrap saveChatGroup with lock and notify after success', async () => {
    const group = { id: 'g1' } as any;
    await service.saveChatGroup(group, 0);

    expect(mockWithLock).toHaveBeenCalled();
    expect(mockProvider.saveChatGroup).toHaveBeenCalledWith(group, 0);
    expect(mockNotify).toHaveBeenCalledWith('chat_group', 'g1');
  });

  it('should wrap deleteChatGroup with lock and notify after success', async () => {
    await service.deleteChatGroup('g1');

    expect(mockWithLock).toHaveBeenCalled();
    expect(mockProvider.deleteChatGroup).toHaveBeenCalledWith('g1');
    expect(mockNotify).toHaveBeenCalledWith('chat_group', 'g1');
  });

  it('should wrap saveSettings with lock and notify after success', async () => {
    const settings = { endpointUrl: 'test' } as any;
    await service.saveSettings(settings);

    expect(mockWithLock).toHaveBeenCalled();
    expect(mockProvider.saveSettings).toHaveBeenCalledWith(settings);
    expect(mockNotify).toHaveBeenCalledWith('settings');
  });

  it('should wrap clearAll with lock and notify migration', async () => {
    await service.clearAll();

    expect(mockWithLock).toHaveBeenCalled();
    expect(mockProvider.clearAll).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith('migration');
  });

  it('should wrap saveFile with lock but not notify (tied to chat)', async () => {
    const blob = new Blob(['test']);
    await service.saveFile(blob, 'a1', 'test.txt');

    expect(mockWithLock).toHaveBeenCalled();
    expect(mockProvider.saveFile).toHaveBeenCalledWith(blob, 'a1', 'test.txt');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('should NOT notify if the operation inside lock fails', async () => {
    mockProvider.saveChat.mockRejectedValue(new Error('Failed'));

    await expect(service.saveChat({ id: 'c1' } as any, 0)).rejects.toThrow('Failed');

    expect(mockWithLock).toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('should notify migration after switchProvider with 60s timeout', async () => {
    mockProvider.dump.mockImplementation(async function* () {});
    
    await service.switchProvider('opfs');

    expect(mockWithLock).toHaveBeenCalledWith(expect.any(Function), { timeoutMs: 60000 });
    expect(mockNotify).toHaveBeenCalledWith('migration');
  });

  it('should report timeout error via addErrorEvent', async () => {
    const timeoutError = new Error('Lock acquisition timed out after 10000ms');
    mockWithLock.mockRejectedValueOnce(timeoutError);

    await expect(service.saveChat({ id: 'c1' } as any, 0)).rejects.toThrow(timeoutError);

    expect(mockAddErrorEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('timed out'),
      details: timeoutError,
    }));
  });

  it('should report generic storage error via addErrorEvent', async () => {
    const diskError = new Error('Disk full');
    mockProvider.saveChat.mockRejectedValueOnce(diskError);

    await expect(service.saveChat({ id: 'c1' } as any, 0)).rejects.toThrow(diskError);

    expect(mockAddErrorEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('An error occurred'),
      details: diskError,
    }));
  });
});