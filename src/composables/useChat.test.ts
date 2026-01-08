import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';

// Mock storage service
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    deleteChat: vi.fn(),
  }
}));

// Mock settings
vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local' } }
  })
}));

describe('useChat Composable Logic', () => {
  const { deleteChat, undoDelete, deleteAllChats, lastDeletedChat } = useChat();

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset state if possible (since useChat uses global refs in the file)
    // For testing global refs, we might need to be careful or reset them manually if exported
  });

  it('should store deleted chat in lastDeletedChat for undo', async () => {
    const mockChat = { id: '1', title: 'Test' };
    vi.mocked(storageService.loadChat).mockResolvedValue(mockChat as any);
    vi.mocked(storageService.deleteChat).mockResolvedValue();

    await deleteChat('1');

    expect(storageService.loadChat).toHaveBeenCalledWith('1');
    expect(lastDeletedChat.value).toEqual(mockChat);
  });

  it('should restore chat on undoDelete', async () => {
    const mockChat = { id: '1', title: 'Test' };
    lastDeletedChat.value = mockChat as any;
    vi.mocked(storageService.saveChat).mockResolvedValue();
    vi.mocked(storageService.listChats).mockResolvedValue([]);

    await undoDelete();

    expect(storageService.saveChat).toHaveBeenCalledWith(mockChat);
    expect(lastDeletedChat.value).toBeNull();
  });

  it('should delete all chats when deleteAllChats is called', async () => {
    const mockSummaries = [{ id: '1' }, { id: '2' }];
    vi.mocked(storageService.listChats).mockResolvedValue(mockSummaries as any);
    vi.mocked(storageService.deleteChat).mockResolvedValue();

    await deleteAllChats();

    expect(storageService.deleteChat).toHaveBeenCalledTimes(2);
    expect(lastDeletedChat.value).toBeNull();
  });

  it('should rename a chat and update storage', async () => {
    const { renameChat } = useChat();
    const mockChat = { id: '1', title: 'Old Title' };
    vi.mocked(storageService.loadChat).mockResolvedValue(mockChat as any);
    vi.mocked(storageService.saveChat).mockResolvedValue();

    await renameChat('1', 'New Title');

    expect(storageService.loadChat).toHaveBeenCalledWith('1');
    expect(storageService.saveChat).toHaveBeenCalledWith(expect.objectContaining({
      id: '1',
      title: 'New Title'
    }));
  });
});
