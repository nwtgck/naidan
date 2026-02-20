import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import { useChatSearch } from './useChatSearch';
import { storageService } from '../services/storage';
import * as chatSearchUtils from '../utils/chat-search';

vi.mock('../services/storage', () => ({
  storageService: {
    getSidebarStructure: vi.fn(),
    loadChatContent: vi.fn(),
  },
}));

vi.mock('../utils/chat-search', () => ({
  searchChatTree: vi.fn(),
  searchLinearBranch: vi.fn(),
}));

describe('useChatSearch Composable', () => {
  let search: ReturnType<typeof useChatSearch>['search'];
  let results: ReturnType<typeof useChatSearch>['results'];
  let query: ReturnType<typeof useChatSearch>['query'];

  beforeEach(() => {
    const composable = useChatSearch();
    search = composable.search;
    results = composable.results;
    query = composable.query;
    vi.clearAllMocks();
  });

  it('should skip search if trimmed query is the same', async () => {
    const mockSidebar = [{ id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } }];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);

    await search({ searchQuery: 'test', options: { scope: 'title_only' } });
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(1);

    await search({ searchQuery: 'test ', options: { scope: 'title_only' } });
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(1); // Should be skipped
  });

  it('should manage isScanningContent flag', async () => {
    const composable = useChatSearch();
    const mockSidebar = [{ id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } }];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);
    vi.mocked(storageService.loadChatContent).mockResolvedValue({ root: { items: [] } } as any);

    const promise = composable.search({ searchQuery: 'test', options: { scope: 'all' } });

    await nextTick();
    await promise;
    expect(composable.isScanningContent.value).toBe(false);
  });

  it('should match by group name independently', async () => {
    const mockSidebar = [
      {
        id: 'group1',
        type: 'chat_group',
        chatGroup: {
          id: 'group1',
          name: 'Work',
          updatedAt: 150,
          items: [{ id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', groupId: 'group1', updatedAt: 100 } }]
        }
      }
    ];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);

    await search({
      searchQuery: 'Work',
      options: { scope: 'title_only' }
    });

    expect(results.value).toHaveLength(1);
    const first = results.value[0];
    if (first && first.type === 'chat_group') {
      expect(first.item.name).toBe('Work');
      expect(first.item.chatCount).toBe(1);
    } else {
      throw new Error('Expected chat_group result');
    }
  });

  it('should match "new chat" for null titles', async () => {
    const mockSidebar = [{ id: 'chat1', type: 'chat', chat: { id: 'chat1', title: null, updatedAt: 100 } }];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);

    await search({
      searchQuery: 'new chat',
      options: { scope: 'title_only' }
    });

    expect(results.value).toHaveLength(1);
    const first = results.value[0];
    if (first && first.type === 'chat') {
      expect(first.item.chatId).toBe('chat1');
      expect(first.item.title).toBe('New Chat');
    } else {
      throw new Error('Expected chat result');
    }
  });

  it('should preserve raw query with spaces but search with trimmed version', async () => {
    const mockSidebar = [{ id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } }];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);

    await search({
      searchQuery: 'test  ', // trailing spaces
      options: { scope: 'title_only' }
    });

    expect(query.value).toBe('test  '); // Raw preserved
    expect(results.value).toHaveLength(1); // Still found it
    expect(results.value[0]!.type).toBe('chat');
  });

  it('should filter by chatGroupIds', async () => {
    const mockSidebar = [
      {
        id: 'group1',
        type: 'chat_group',
        chatGroup: {
          id: 'group1',
          name: 'Group 1',
          items: [
            { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', groupId: 'group1', updatedAt: 100 } },
            { id: 'chat3', type: 'chat', chat: { id: 'chat3', title: 'Chat 3', groupId: 'group1', updatedAt: 300 } }
          ]
        }
      },
      {
        id: 'group2',
        type: 'chat_group',
        chatGroup: {
          id: 'group2',
          name: 'Group 2',
          items: [{ id: 'chat2', type: 'chat', chat: { id: 'chat2', title: 'Chat 2', groupId: 'group2', updatedAt: 200 } }]
        }
      }
    ];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);
    vi.mocked(chatSearchUtils.searchChatTree).mockReturnValue([]);

    await search({
      searchQuery: 'test',
      options: { scope: 'all', chatGroupIds: ['group1'] }
    });

    expect(storageService.loadChatContent).toHaveBeenCalledWith('chat1');
    expect(storageService.loadChatContent).toHaveBeenCalledWith('chat3');
    expect(storageService.loadChatContent).not.toHaveBeenCalledWith('chat2');
  });

  it('should filter by specific chatId', async () => {
    const mockSidebar = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', updatedAt: 100 } },
      { id: 'chat2', type: 'chat', chat: { id: 'chat2', title: 'Chat 2', updatedAt: 200 } }
    ];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);

    await search({
      searchQuery: 'test',
      options: { scope: 'all', chatId: 'chat2' }
    });

    expect(storageService.loadChatContent).toHaveBeenCalledWith('chat2');
    expect(storageService.loadChatContent).not.toHaveBeenCalledWith('chat1');
  });

  it('should handle AND search keywords in titles', async () => {
    const mockSidebar = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Hello World Test', updatedAt: 100 } },
      { id: 'chat2', type: 'chat', chat: { id: 'chat2', title: 'Hello World', updatedAt: 200 } }
    ];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);

    await search({
      searchQuery: 'hello test',
      options: { scope: 'title_only' }
    });

    expect(results.value).toHaveLength(1);
    const first = results.value[0]!;
    if (first.type === 'chat') {
      expect(first.item.chatId).toBe('chat1');
    } else {
      throw new Error('Expected chat result');
    }
  });

  it('should set matchType to "both" if keywords match in both title and content', async () => {
    const mockSidebar = [{ id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Hello World', updatedAt: 100 } }];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);
    vi.mocked(storageService.loadChatContent).mockResolvedValue({
      root: { items: [] },
      currentLeafId: 'leaf1'
    } as any);
    vi.mocked(chatSearchUtils.searchChatTree).mockReturnValue([
      { messageId: 'm1', excerpt: 'hello content', fullContent: 'hello content', role: 'user', timestamp: 100, isCurrentThread: true, targetLeafId: 'leaf1', chatId: 'chat1' }
    ]);

    await search({ searchQuery: 'hello', options: { scope: 'all' } });

    expect(results.value).toHaveLength(2); // Header + Message match
    const first = results.value[0]!;
    if (first.type === 'chat') {
      expect(first.item.matchType).toBe('both');
      expect(first.item.contentMatches).toHaveLength(1);
    } else {
      throw new Error('Expected chat header');
    }
  });

  it('should include groupName in chat results', async () => {
    const mockSidebar = [
      {
        id: 'group1',
        type: 'chat_group',
        chatGroup: {
          id: 'group1',
          name: 'Work',
          items: [{ id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', groupId: 'group1', updatedAt: 100 } }]
        }
      }
    ];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);

    await search({ searchQuery: 'Chat', options: { scope: 'title_only' } });

    const first = results.value[0]!;
    if (first.type === 'chat') {
      expect(first.item.groupName).toBe('Work');
    } else {
      throw new Error('Expected chat result');
    }
  });

  it('should prioritize items by sidebar order', async () => {
    const mockSidebar = [
      {
        id: 'group1',
        type: 'chat_group',
        chatGroup: {
          id: 'group1',
          name: 'Older Group',
          updatedAt: 100,
          items: []
        }
      },
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Newer Individual Chat', updatedAt: 2000 } }
    ];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);

    // Search for 'e' which matches both 'Newer' and 'Older'
    await search({ searchQuery: 'e', options: { scope: 'title_only' } });

    expect(results.value).toHaveLength(2);
    // Follows sidebar order: Group first, then Chat
    expect(results.value[0]!.type).toBe('chat_group');
    expect(results.value[1]!.type).toBe('chat');
  });

  it('should list all groups and chats if query is empty and scope is title_only', async () => {
    const mockSidebar = [
      { id: 'group1', type: 'chat_group', chatGroup: { id: 'group1', name: 'Work', items: [] } },
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', updatedAt: 100 } }
    ];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);

    await search({ searchQuery: '', options: { scope: 'title_only' } });

    expect(results.value).toHaveLength(2);
    expect(results.value[0]!.type).toBe('chat_group');
    expect(results.value[1]!.type).toBe('chat');
  });

  it('should clear sidebar cache when clearSearch is called', async () => {
    const { search, clearSearch } = useChatSearch();
    const mockSidebar = [{ id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } }];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);

    // First search - should call storage
    await search({ searchQuery: 'test', options: { scope: 'title_only' } });
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(1);

    // Second search - should use cache
    await search({ searchQuery: 'tes', options: { scope: 'title_only' } });
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(1);

    // Clear search - should reset cache
    clearSearch();

    // Third search - should call storage again
    await search({ searchQuery: 'test', options: { scope: 'title_only' } });
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(2);
  });

  it('should invalidate cache but preserve query/results when stopSearch is called', async () => {
    const { search, stopSearch, query, results } = useChatSearch();
    const mockSidebar = [{ id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } }];
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue(mockSidebar as any);

    // 1. Search to populate query and results
    await search({ searchQuery: 'test', options: { scope: 'title_only' } });
    expect(query.value).toBe('test');
    expect(results.value).toHaveLength(1);
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(1);

    // 2. Stop search - should invalidate cache but keep query/results
    stopSearch();
    expect(query.value).toBe('test');
    expect(results.value).toHaveLength(1);

    // 3. Search again with same query - should call storage again because cache was invalidated
    await search({ searchQuery: 'test', options: { scope: 'title_only' } });
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(2);
  });
});
