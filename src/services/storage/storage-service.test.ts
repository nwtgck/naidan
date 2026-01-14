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
});
