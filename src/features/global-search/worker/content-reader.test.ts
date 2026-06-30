import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGlobalSearchRemoteContentReader } from './content-reader';
import { storageService } from '@/00-storage/service';

vi.mock('@/00-storage/service', () => ({
  storageService: {
    getCurrentType: vi.fn(),
    loadChatContentWithoutAttachments: vi.fn(),
  },
}));

describe('createGlobalSearchRemoteContentReader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to the purpose-specific storage service method', async () => {
    vi.mocked(storageService.getCurrentType).mockReturnValue('local');
    vi.mocked(storageService.loadChatContentWithoutAttachments).mockResolvedValue(null);
    const reader = createGlobalSearchRemoteContentReader({ storageType: 'local' });

    await expect(reader.loadChatContentWithoutAttachments({ chatId: 'chat-1' })).resolves.toBeNull();
    expect(storageService.loadChatContentWithoutAttachments).toHaveBeenCalledWith({ id: 'chat-1' });
  });

  it('rejects calls after the active storage type changes', async () => {
    vi.mocked(storageService.getCurrentType).mockReturnValue('opfs');
    const reader = createGlobalSearchRemoteContentReader({ storageType: 'memory' });

    await expect(reader.loadChatContentWithoutAttachments({ chatId: 'chat-1' })).rejects.toThrow(
      'expected memory storage, received: opfs',
    );
    expect(storageService.loadChatContentWithoutAttachments).not.toHaveBeenCalled();
  });
});
