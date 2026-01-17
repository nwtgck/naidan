import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storageService } from './index';

const { mockLocalProvider, mockOpfsProvider } = vi.hoisted(() => ({
  mockLocalProvider: {
    init: vi.fn().mockResolvedValue(undefined),
    dump: vi.fn(),
    restore: vi.fn(),
    loadChat: vi.fn().mockResolvedValue(null),
    listChats: vi.fn().mockResolvedValue([]),
    clearAll: vi.fn().mockResolvedValue(undefined),
  },
  mockOpfsProvider: {
    init: vi.fn().mockResolvedValue(undefined),
    dump: vi.fn(),
    restore: vi.fn(),
    loadChat: vi.fn().mockResolvedValue(null),
    clearAll: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock the modules
vi.mock('./local-storage', () => ({
  LocalStorageProvider: vi.fn().mockImplementation(function() { return mockLocalProvider; }),
}));

vi.mock('./opfs-storage', () => ({
  OPFSStorageProvider: vi.fn().mockImplementation(function() { return mockOpfsProvider; }),
}));

const mockAddErrorEvent = vi.fn();
vi.mock('../../composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: mockAddErrorEvent,
  }),
}));

describe('StorageService Initialization Protection', () => {
  it('should throw error when getCurrentType is called before init', () => {
    // We need a fresh instance for this test
    const freshService = new (storageService.constructor as any)();
    expect(() => freshService.getCurrentType()).toThrow('StorageService not initialized');
  });

  it('should throw error when a domain method is called before init', async () => {
    const freshService = new (storageService.constructor as any)();
    await expect(freshService.listChats()).rejects.toThrow('StorageService not initialized');
  });
});

describe('StorageService Initialization Defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn() },
    });
  });

  it('should use opfs when requested and supported', async () => {
    (navigator.storage.getDirectory as any).mockResolvedValue({});
    
    await storageService.init('opfs');
    expect(storageService.getCurrentType()).toBe('opfs');
  });

  it('should use local when requested even if opfs is supported', async () => {
    (navigator.storage.getDirectory as any).mockResolvedValue({});
    
    await storageService.init('local');
    expect(storageService.getCurrentType()).toBe('local');
  });

  it('should fallback to "local" if "opfs" was requested but is no longer supported', async () => {
    (navigator.storage.getDirectory as any).mockRejectedValue(new Error('No OPFS'));
    
    await storageService.init('opfs');
    expect(storageService.getCurrentType()).toBe('local');
  });
});

describe('StorageService Migration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn() },
    });
    
    // Force reset the singleton state and inject our mock
    const service = storageService as unknown as { currentType: string; provider: unknown };
    service.currentType = 'local';
    service.provider = mockLocalProvider;

    mockLocalProvider.init.mockResolvedValue(undefined);
    mockOpfsProvider.init.mockResolvedValue(undefined);
    mockLocalProvider.dump.mockImplementation(async function* () {
      yield { type: 'settings', data: {} as any };
    });
    mockOpfsProvider.restore.mockImplementation(async (stream) => {
      for await (const _chunk of stream) {
        // consume stream
      }
    });
  });

  it('should migrate data when switching from local to opfs', async () => {
    // Act
    await storageService.switchProvider('opfs');

    // Assert
    expect(mockLocalProvider.dump).toHaveBeenCalled();
    expect(mockOpfsProvider.restore).toHaveBeenCalled();
    expect(storageService.getCurrentType()).toBe('opfs');
  });

  it('should log error to global events and throw if migration fails', async () => {
    // Setup
    const error = new Error('Migration failed');
    mockOpfsProvider.restore.mockRejectedValue(error);

    // Act & Assert
    await expect(storageService.switchProvider('opfs')).rejects.toThrow(error);
    
    expect(mockAddErrorEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: 'StorageService',
      message: expect.stringContaining('failed'),
      details: error,
    }));
    
    // Should stay as 'local' because migration failed
    expect(storageService.getCurrentType()).toBe('local');
  });

  it('should rescue memory blobs during local -> opfs migration', async () => {
    // Setup a chat with a memory attachment (not yet persisted in LocalStorage)
    const mockBlob = new Blob(['test'], { type: 'image/png' });
    const chat: any = {
      id: 'chat-1',
      title: 'Test',
      root: {
        items: [{
          id: 'msg-1',
          role: 'user',
          content: 'hello',
          attachments: [{
            id: 'att-1',
            status: 'memory',
            blob: mockBlob,
            originalName: 'test.png',
            mimeType: 'image/png',
            size: 4,
            uploadedAt: Date.now()
          }],
          replies: { items: [] }
        }]
      }
    };

    mockLocalProvider.dump.mockImplementation(async function* () {
      yield { type: 'chat', data: { id: 'chat-1' } as any };
    });
    mockLocalProvider.loadChat.mockResolvedValue(chat);
    // OPFS supports binary
    (mockOpfsProvider as any).canPersistBinary = true;

    const receivedChunks: any[] = [];
    mockOpfsProvider.restore.mockImplementation(async (stream) => {
      for await (const chunk of stream) {
        receivedChunks.push(chunk);
      }
    });

    await storageService.switchProvider('opfs');

    // Should have rescued the attachment
    const attachmentChunk = receivedChunks.find(c => c.type === 'attachment');
    expect(attachmentChunk).toBeDefined();
    expect(attachmentChunk.attachmentId).toBe('att-1');
    expect(attachmentChunk.blob).toBe(mockBlob);

    // Chat chunk should have been updated to 'persisted' status
    const chatChunk = receivedChunks.find(c => c.type === 'chat');
    expect(chatChunk.data.root.items[0].attachments[0].status).toBe('persisted');
  });

  it('should rescue attachments in nested replies (recursion test)', async () => {
    const mockBlob = new Blob(['nested'], { type: 'image/png' });
    const chat: any = {
      id: 'chat-recursive',
      root: {
        items: [{
          id: 'msg-1',
          replies: {
            items: [{
              id: 'msg-2',
              attachments: [{
                id: 'att-nested',
                status: 'memory',
                blob: mockBlob,
                originalName: 'nested.png',
                mimeType: 'image/png',
                size: 6,
                uploadedAt: Date.now()
              }],
              replies: { items: [] }
            }]
          }
        }]
      }
    };

    mockLocalProvider.dump.mockImplementation(async function* () {
      yield { type: 'chat', data: { id: 'chat-recursive' } as any };
    });
    mockLocalProvider.loadChat.mockResolvedValue(chat);
    (mockOpfsProvider as any).canPersistBinary = true;

    const receivedChunks: any[] = [];
    mockOpfsProvider.restore.mockImplementation(async (stream) => {
      for await (const chunk of stream) {
        receivedChunks.push(chunk);
      }
    });

    await storageService.switchProvider('opfs');

    const attachmentChunk = receivedChunks.find(c => c.type === 'attachment');
    expect(attachmentChunk).toBeDefined();
    expect(attachmentChunk.attachmentId).toBe('att-nested');
  });
});
