import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatSearch } from './useChatSearch';
import { storageService } from '../services/storage';
import * as chatSearchUtils from '../utils/chat-search';

vi.mock('../services/storage', () => ({
  storageService: {
    listChats: vi.fn(),
    loadChatContent: vi.fn(),
  },
}));

vi.mock('../utils/chat-search', () => ({
  searchChatTree: vi.fn(),
  searchLinearBranch: vi.fn(),
}));

describe('useChatSearch Composable', () => {
  const { search, results } = useChatSearch();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should filter by chatGroupIds', async () => {
    const mockChats = [
      { id: 'chat1', title: 'Chat 1', groupId: 'group1', updatedAt: 100 },
      { id: 'chat2', title: 'Chat 2', groupId: 'group2', updatedAt: 200 },
      { id: 'chat3', title: 'Chat 3', groupId: 'group1', updatedAt: 300 },
    ];
    vi.mocked(storageService.listChats).mockResolvedValue(mockChats as any);
    vi.mocked(chatSearchUtils.searchChatTree).mockReturnValue([]);

    await search({ 
      searchQuery: 'test', 
      options: { scope: 'all', chatGroupIds: ['group1'] } 
    });

    // Should only process chats in group1 (chat1 and chat3)
    // Title search is done for all filtered chats.
    // In this case, 'test' doesn't match titles 'Chat 1' or 'Chat 3'.
    // Then it calls loadChatContent for those.
    expect(storageService.loadChatContent).toHaveBeenCalledWith('chat1');
    expect(storageService.loadChatContent).toHaveBeenCalledWith('chat3');
    expect(storageService.loadChatContent).not.toHaveBeenCalledWith('chat2');
  });

  it('should filter by specific chatId', async () => {
    const mockChats = [
      { id: 'chat1', title: 'Chat 1', groupId: 'group1', updatedAt: 100 },
      { id: 'chat2', title: 'Chat 2', groupId: 'group2', updatedAt: 200 },
    ];
    vi.mocked(storageService.listChats).mockResolvedValue(mockChats as any);

    await search({ 
      searchQuery: 'test', 
      options: { scope: 'all', chatId: 'chat2' } 
    });

    expect(storageService.loadChatContent).toHaveBeenCalledWith('chat2');
    expect(storageService.loadChatContent).not.toHaveBeenCalledWith('chat1');
  });

  it('should handle AND search keywords in titles', async () => {
    const mockChats = [
      { id: 'chat1', title: 'Hello World Test', updatedAt: 100 },
      { id: 'chat2', title: 'Hello World', updatedAt: 200 },
    ];
    vi.mocked(storageService.listChats).mockResolvedValue(mockChats as any);

    await search({ 
      searchQuery: 'hello test', 
      options: { scope: 'title_only' } 
    });

    expect(results.value).toHaveLength(1);
    expect(results.value[0]!.chatId).toBe('chat1');
  });
});
