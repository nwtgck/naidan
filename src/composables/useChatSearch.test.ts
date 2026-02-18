import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import { useChatSearch } from './useChatSearch';
import { storageService } from '../services/storage';
import * as chatSearchUtils from '../utils/chat-search';

vi.mock('../services/storage', () => ({
  storageService: {
    listChats: vi.fn(),
    listChatGroups: vi.fn(),
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
    vi.mocked(storageService.listChatGroups).mockResolvedValue([]);
  });

  it('should skip search if trimmed query is the same', async () => {
    const mockChats = [{ id: 'chat1', title: 'Test', updatedAt: 100 }];
    vi.mocked(storageService.listChats).mockResolvedValue(mockChats as any);

    await search({ searchQuery: 'test', options: { scope: 'title_only' } });
    expect(storageService.listChats).toHaveBeenCalledTimes(1);

    await search({ searchQuery: 'test ', options: { scope: 'title_only' } });
    expect(storageService.listChats).toHaveBeenCalledTimes(1); // Should be skipped
  });

  it('should manage isScanningContent flag', async () => {
    const composable = useChatSearch();
    const mockChats = [{ id: 'chat1', title: 'Test', updatedAt: 100 }];
    vi.mocked(storageService.listChats).mockResolvedValue(mockChats as any);
    vi.mocked(storageService.loadChatContent).mockResolvedValue({ root: { items: [] } } as any);

    const promise = composable.search({ searchQuery: 'test', options: { scope: 'all' } });

    await nextTick();
    await promise;
    expect(composable.isScanningContent.value).toBe(false);
  });

  it('should match by group name independently', async () => {
    const mockChats = [
      { id: 'chat1', title: 'Chat 1', groupId: 'group1', updatedAt: 100 },
    ];
    const mockGroups = [
      { id: 'group1', name: 'Work', updatedAt: 150 },
    ];
    vi.mocked(storageService.listChats).mockResolvedValue(mockChats as any);
    vi.mocked(storageService.listChatGroups).mockResolvedValue(mockGroups as any);

    await search({
      searchQuery: 'Work',
      options: { scope: 'title_only' }
    });

    expect(results.value).toHaveLength(1);
    const first = results.value[0];
    if (first && first.type === 'chat_group') {
      expect(first.name).toBe('Work');
    }
  });

  it('should match "new chat" for null titles', async () => {
    const mockChats = [
      { id: 'chat1', title: null, updatedAt: 100 },
    ];
    vi.mocked(storageService.listChats).mockResolvedValue(mockChats as any);
    vi.mocked(storageService.listChatGroups).mockResolvedValue([]);

    await search({
      searchQuery: 'new chat',
      options: { scope: 'title_only' }
    });

    expect(results.value).toHaveLength(1);
    const first = results.value[0];
    if (first && first.type === 'chat') {
      expect(first.chatId).toBe('chat1');
      expect(first.title).toBe('New Chat');
    }
  });

  it('should preserve raw query with spaces but search with trimmed version', async () => {
    const mockChats = [{ id: 'chat1', title: 'Test', updatedAt: 100 }];
    vi.mocked(storageService.listChats).mockResolvedValue(mockChats as any);

    await search({
      searchQuery: 'test  ', // trailing spaces
      options: { scope: 'title_only' }
    });

    expect(query.value).toBe('test  '); // Raw preserved
    expect(results.value).toHaveLength(1); // Still found it
    expect(results.value[0]!.type).toBe('chat');
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
    const first = results.value[0]!;
    if (first.type === 'chat') {
      expect(first.chatId).toBe('chat1');
    } else {
      throw new Error('Expected chat result');
    }
  });

  it('should set matchType to "both" if keywords match in both title and content', async () => {
    const mockChats = [{ id: 'chat1', title: 'Hello World', updatedAt: 100 }];
    vi.mocked(storageService.listChats).mockResolvedValue(mockChats as any);
    vi.mocked(storageService.loadChatContent).mockResolvedValue({
      root: { items: [] },
      currentLeafId: 'leaf1'
    } as any);
    vi.mocked(chatSearchUtils.searchChatTree).mockReturnValue([
      { messageId: 'm1', excerpt: 'hello content', fullContent: 'hello content', role: 'user', timestamp: 100, isCurrentThread: true, targetLeafId: 'leaf1', chatId: 'chat1' }
    ]);

    await search({ searchQuery: 'hello', options: { scope: 'all' } });

    expect(results.value).toHaveLength(1);
    const first = results.value[0]!;
    if (first.type === 'chat') {
      expect(first.matchType).toBe('both');
      expect(first.contentMatches).toHaveLength(1);
    }
  });

  it('should include groupName in chat results', async () => {
    const mockChats = [{ id: 'chat1', title: 'Chat 1', groupId: 'g1', updatedAt: 100 }];
    const mockGroups = [{ id: 'g1', name: 'Work', updatedAt: 100 }];
    vi.mocked(storageService.listChats).mockResolvedValue(mockChats as any);
    vi.mocked(storageService.listChatGroups).mockResolvedValue(mockGroups as any);

    await search({ searchQuery: 'Chat', options: { scope: 'title_only' } });

    const first = results.value[0]!;
    if (first.type === 'chat') {
      expect(first.groupName).toBe('Work');
    }
  });

  it('should prioritize chat groups over individual chats even if chats are newer', async () => {
    const mockChats = [
      { id: 'chat1', title: 'Newer Individual Chat', updatedAt: 2000 },
    ];
    const mockGroups = [
      { id: 'group1', name: 'Older Group', updatedAt: 100 },
    ];
    vi.mocked(storageService.listChats).mockResolvedValue(mockChats as any);
    vi.mocked(storageService.listChatGroups).mockResolvedValue(mockGroups as any);

    // Search for 'o' which matches both 'Newer' and 'Group' (case-insensitive depends on impl, but 'o' is in both)
    // Actually search for 'e' to be safer as it is in both 'Newer' and 'Older'
    await search({ searchQuery: 'e', options: { scope: 'title_only' } });

    expect(results.value).toHaveLength(2);
    // Even though the chat is newer (2000 > 100), the group should be first
    expect(results.value[0]!.type).toBe('chat_group');
    expect(results.value[1]!.type).toBe('chat');
  });
});
