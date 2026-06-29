import { idToRaw, toChatId } from '@/01-models/ids';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import type { SidebarItem } from '@/01-models/types';
import { storageService } from '@/00-storage/service';

const {
  mockCreateGlobalSearchWorkerClient,
  storageChangeListeners,
} = vi.hoisted(() => ({
  mockCreateGlobalSearchWorkerClient: vi.fn(),
  storageChangeListeners: new Set<(payload: any) => void>(),
}));

vi.mock('../../../00-storage/service', () => ({
  storageService: {
    getCurrentType: vi.fn(),
    loadChatContentWithoutAttachments: vi.fn(),
    subscribeToChanges: vi.fn(({ listener }) => {
      storageChangeListeners.add(listener);
      return () => storageChangeListeners.delete(listener);
    }),
  },
}));

vi.mock('@/features/global-search/worker/client', () => ({
  createGlobalSearchWorkerClient: mockCreateGlobalSearchWorkerClient,
}));

const sidebarItems = ref<SidebarItem[]>([]);

async function createComposable() {
  const { useChatSearch } = await import('./useChatSearch');
  return useChatSearch({ sidebarItems });
}


describe('useChatSearch Composable', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storageChangeListeners.clear();
    sidebarItems.value = [];

    vi.mocked(storageService.getCurrentType).mockReturnValue('memory');
    mockCreateGlobalSearchWorkerClient.mockImplementation(async ({ storageType }: {
      storageType: import('@/01-models/types').StorageType,
    }) => {
      const { createGlobalSearchWorker } = await import('@/features/global-search/worker/impl');
      const worker = createGlobalSearchWorker();
      await worker.configureStorage(storageType, {
        loadChatContentWithoutAttachments({ chatId }: { chatId: string }) {
          return storageService.loadChatContentWithoutAttachments({ id: chatId as never });
        },
      });

      return {
        searchChatContent({ request }: { request: import('@/features/global-search/worker/types').GlobalSearchWorkerSearchChatContentRequest }) {
          return worker.searchChatContent({
            request: {
              ...request,
              storageType,
            },
          });
        },
        dispose: vi.fn().mockResolvedValue(undefined),
      };
    });
  });

  it('should skip search if trimmed query is the same', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never;

    await composable.search({ searchQuery: 'test', options: { scope: 'title_only' } });
    await composable.search({ searchQuery: 'test ', options: { scope: 'title_only' } });

    expect(composable.query.value).toBe('test ');
    expect(composable.results.value).toHaveLength(1);
    expect(mockCreateGlobalSearchWorkerClient).not.toHaveBeenCalled();
  });

  it('should rerun search when scope changes for the same trimmed query', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Hello World', updatedAt: 100 } },
    ] as never;
    vi.mocked(storageService.loadChatContentWithoutAttachments).mockResolvedValue({
      root: {
        items: [{
          id: 'm1',
          content: 'hello content',
          timestamp: 100,
          role: 'user',
          replies: { items: [] },
        }],
      },
      currentLeafId: 'm1',
    } as never);

    await composable.search({ searchQuery: 'hello', options: { scope: 'title_only' } });
    expect(composable.results.value).toHaveLength(1);
    expect(storageService.loadChatContentWithoutAttachments).not.toHaveBeenCalled();

    await composable.search({ searchQuery: 'hello', options: { scope: 'all' } });
    expect(storageService.loadChatContentWithoutAttachments).toHaveBeenCalledWith({ id: 'chat1' });
  });

  it('should stop scanning after a worker request fails and allow the same search to retry', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const searchChatContent = vi.fn().mockRejectedValue(new Error('worker request failed'));
    const dispose = vi.fn().mockResolvedValue(undefined);
    mockCreateGlobalSearchWorkerClient.mockResolvedValue({
      searchChatContent,
      dispose,
    });
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', updatedAt: 100 } },
      { id: 'chat2', type: 'chat', chat: { id: 'chat2', title: 'Chat 2', updatedAt: 200 } },
    ] as never;

    await composable.search({ searchQuery: 'content', options: { scope: 'all' } });

    expect(searchChatContent).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith(
      'Failed to search content for chat chat1',
      expect.any(Error),
    );

    mockCreateGlobalSearchWorkerClient.mockResolvedValue({
      searchChatContent: vi.fn().mockResolvedValue({ matches: [] }),
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    await composable.search({ searchQuery: 'content', options: { scope: 'all' } });

    expect(mockCreateGlobalSearchWorkerClient).toHaveBeenCalledTimes(2);
    consoleWarn.mockRestore();
  });

  it('should settle searching state when worker creation fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreateGlobalSearchWorkerClient.mockRejectedValueOnce(new Error('worker failed'));
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never;

    await expect(composable.search({
      searchQuery: 'test',
      options: { scope: 'all' },
    })).resolves.toBeUndefined();

    expect(composable.isSearching.value).toBe(false);
    expect(composable.isScanningContent.value).toBe(false);
    expect(consoleError).toHaveBeenCalledWith('Failed to run Global Search', expect.any(Error));
    consoleError.mockRestore();
  });

  it('should manage isScanningContent flag', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never;
    vi.mocked(storageService.loadChatContentWithoutAttachments).mockResolvedValue({ root: { items: [] } } as never);

    const promise = composable.search({ searchQuery: 'test', options: { scope: 'all' } });
    await nextTick();
    await promise;

    expect(composable.isScanningContent.value).toBe(false);
  });

  it('should match by group name independently', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      {
        id: 'group1',
        type: 'chat_group',
        chatGroup: {
          id: 'group1',
          name: 'Work',
          updatedAt: 150,
          items: [{ id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', groupId: 'group1', updatedAt: 100 } }],
        },
      },
    ] as never;

    await composable.search({ searchQuery: 'Work', options: { scope: 'title_only' } });

    expect(composable.results.value).toHaveLength(1);
    const first = composable.results.value[0];
    expect(first?.type).toBe('chat_group');
  });

  it('should match "new chat" for null titles', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: null, updatedAt: 100 } },
    ] as never;

    await composable.search({ searchQuery: 'new chat', options: { scope: 'title_only' } });

    expect(composable.results.value).toHaveLength(1);
    expect(composable.results.value[0]?.type).toBe('chat');
  });

  it('should preserve raw query with spaces but search with trimmed version', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never;

    await composable.search({ searchQuery: 'test  ', options: { scope: 'title_only' } });

    expect(composable.query.value).toBe('test  ');
    expect(composable.results.value).toHaveLength(1);
  });

  it('should filter content scanning by chatGroupIds', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      {
        id: 'group1',
        type: 'chat_group',
        chatGroup: {
          id: 'group1',
          name: 'Group 1',
          updatedAt: 100,
          items: [
            { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', groupId: 'group1', updatedAt: 100 } },
            { id: 'chat3', type: 'chat', chat: { id: 'chat3', title: 'Chat 3', groupId: 'group1', updatedAt: 300 } },
          ],
        },
      },
      {
        id: 'group2',
        type: 'chat_group',
        chatGroup: {
          id: 'group2',
          name: 'Group 2',
          updatedAt: 200,
          items: [{ id: 'chat2', type: 'chat', chat: { id: 'chat2', title: 'Chat 2', groupId: 'group2', updatedAt: 200 } }],
        },
      },
    ] as never;
    vi.mocked(storageService.loadChatContentWithoutAttachments).mockResolvedValue({ root: { items: [] } } as never);

    await composable.search({
      searchQuery: 'test',
      options: { scope: 'all', chatGroupIds: ['group1'] },
    });

    expect(storageService.loadChatContentWithoutAttachments).toHaveBeenCalledWith({ id: 'chat1' });
    expect(storageService.loadChatContentWithoutAttachments).toHaveBeenCalledWith({ id: 'chat3' });
    expect(storageService.loadChatContentWithoutAttachments).not.toHaveBeenCalledWith({ id: 'chat2' });
  });

  it('should filter by specific chatId', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', updatedAt: 100 } },
      { id: 'chat2', type: 'chat', chat: { id: 'chat2', title: 'Chat 2', updatedAt: 200 } },
    ] as never;
    vi.mocked(storageService.loadChatContentWithoutAttachments).mockResolvedValue({ root: { items: [] } } as never);

    await composable.search({
      searchQuery: 'test',
      options: { scope: 'all', chatId: idToRaw({ id: toChatId({ raw: 'chat2' }) }) },
    });

    expect(storageService.loadChatContentWithoutAttachments).toHaveBeenCalledWith({ id: idToRaw({ id: toChatId({ raw: 'chat2' }) }) });
    expect(storageService.loadChatContentWithoutAttachments).not.toHaveBeenCalledWith({ id: 'chat1' });
  });

  it('should set matchType to both if keywords match in both title and content', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Hello World', updatedAt: 100 } },
    ] as never;
    vi.mocked(storageService.loadChatContentWithoutAttachments).mockResolvedValue({
      root: {
        items: [{
          id: 'm1',
          content: 'hello content',
          timestamp: 100,
          role: 'user',
          replies: { items: [] },
        }],
      },
      currentLeafId: 'm1',
    } as never);

    await composable.search({ searchQuery: 'hello', options: { scope: 'all' } });

    expect(composable.results.value).toHaveLength(2);
    const first = composable.results.value[0];
    expect(first?.type).toBe('chat');
    if (first?.type === 'chat') {
      expect(first.item.matchType).toBe('both');
      expect(first.item.contentMatches).toHaveLength(1);
    }
  });

  it('should filter content matches by role in the worker path', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Hello World', updatedAt: 100 } },
    ] as never;
    vi.mocked(storageService.loadChatContentWithoutAttachments).mockResolvedValue({
      root: {
        items: [
          {
            id: 'm1',
            content: 'hello from user',
            timestamp: 100,
            role: 'user',
            replies: { items: [] },
          },
          {
            id: 'm2',
            content: 'hello from assistant',
            timestamp: 200,
            role: 'assistant',
            replies: { items: [] },
          },
        ],
      },
      currentLeafId: 'm2',
    } as never);

    await composable.search({ searchQuery: 'hello', options: { scope: 'all', roleFilter: 'assistant' } });

    expect(composable.results.value).toHaveLength(2);
    const messageEntry = composable.results.value[1];
    expect(messageEntry?.type).toBe('message');
    if (messageEntry?.type === 'message') {
      expect(messageEntry.item.role).toBe('assistant');
    }
  });

  it('should rerun search when role filter changes for the same trimmed query', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Hello World', updatedAt: 100 } },
    ] as never;
    vi.mocked(storageService.loadChatContentWithoutAttachments).mockResolvedValue({
      root: {
        items: [
          {
            id: 'm1',
            content: 'hello from user',
            timestamp: 100,
            role: 'user',
            replies: { items: [] },
          },
          {
            id: 'm2',
            content: 'hello from assistant',
            timestamp: 200,
            role: 'assistant',
            replies: { items: [] },
          },
        ],
      },
      currentLeafId: 'm2',
    } as never);

    await composable.search({ searchQuery: 'hello', options: { scope: 'all', roleFilter: 'user' } });
    await composable.search({ searchQuery: 'hello', options: { scope: 'all', roleFilter: 'assistant' } });

    expect(storageService.loadChatContentWithoutAttachments).toHaveBeenCalledTimes(2);
    const messageEntry = composable.results.value[1];
    expect(messageEntry?.type).toBe('message');
    if (messageEntry?.type === 'message') {
      expect(messageEntry.item.role).toBe('assistant');
    }
  });

  it('should handle AND search keywords in titles', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Hello World Test', updatedAt: 100 } },
      { id: 'chat2', type: 'chat', chat: { id: 'chat2', title: 'Hello World', updatedAt: 200 } },
    ] as never;

    await composable.search({
      searchQuery: 'hello test',
      options: { scope: 'title_only' },
    });

    expect(composable.results.value).toHaveLength(1);
    const first = composable.results.value[0];
    expect(first?.type).toBe('chat');
    if (first?.type === 'chat') {
      expect(first.item.chatId).toBe('chat1');
    }
  });

  it('should include groupName in chat results', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      {
        id: 'group1',
        type: 'chat_group',
        chatGroup: {
          id: 'group1',
          name: 'Work',
          updatedAt: 150,
          items: [{ id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', groupId: 'group1', updatedAt: 100 } }],
        },
      },
    ] as never;

    await composable.search({ searchQuery: 'Chat', options: { scope: 'title_only' } });

    const first = composable.results.value[0];
    expect(first?.type).toBe('chat');
    if (first?.type === 'chat') {
      expect(first.item.groupName).toBe('Work');
    }
  });

  it('should prioritize items by sidebar order', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      {
        id: 'group1',
        type: 'chat_group',
        chatGroup: {
          id: 'group1',
          name: 'Older Group',
          updatedAt: 100,
          items: [],
        },
      },
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Newer Individual Chat', updatedAt: 2000 } },
    ] as never;

    await composable.search({ searchQuery: 'e', options: { scope: 'title_only' } });

    expect(composable.results.value).toHaveLength(2);
    expect(composable.results.value[0]?.type).toBe('chat_group');
    expect(composable.results.value[1]?.type).toBe('chat');
  });

  it.each(['title_only', 'all', 'current_thread'] as const)(
    'should list all groups and chats without scanning content for an empty query in %s scope',
    async (scope) => {
      const composable = await createComposable();
      sidebarItems.value = [
        {
          id: 'group1',
          type: 'chat_group',
          chatGroup: {
            id: 'group1',
            name: 'Work',
            updatedAt: 150,
            items: [],
          },
        },
        { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', updatedAt: 100 } },
      ] as never;

      await composable.search({ searchQuery: '', options: { scope } });

      expect(composable.results.value).toHaveLength(2);
      expect(composable.results.value[0]?.type).toBe('chat_group');
      expect(composable.results.value[1]?.type).toBe('chat');
      expect(storageService.getCurrentType).not.toHaveBeenCalled();
      expect(storageService.loadChatContentWithoutAttachments).not.toHaveBeenCalled();
      expect(mockCreateGlobalSearchWorkerClient).not.toHaveBeenCalled();
    },
  );

  it.each(['title_only', 'all', 'current_thread'] as const)(
    'should apply the group filter to an empty query in %s scope',
    async (scope) => {
      const composable = await createComposable();
      sidebarItems.value = [
        {
          id: 'group1',
          type: 'chat_group',
          chatGroup: {
            id: 'group1',
            name: 'Group 1',
            updatedAt: 100,
            items: [{
              id: 'chat1',
              type: 'chat',
              chat: {
                id: 'chat1',
                title: 'Chat 1',
                groupId: 'group1',
                updatedAt: 100,
              },
            }],
          },
        },
        {
          id: 'group2',
          type: 'chat_group',
          chatGroup: {
            id: 'group2',
            name: 'Group 2',
            updatedAt: 200,
            items: [{
              id: 'chat2',
              type: 'chat',
              chat: {
                id: 'chat2',
                title: 'Chat 2',
                groupId: 'group2',
                updatedAt: 200,
              },
            }],
          },
        },
      ] as never;

      await composable.search({
        searchQuery: '',
        options: { scope, chatGroupIds: ['group1'] },
      });

      expect(composable.results.value.map(entry => entry.type)).toEqual([
        'chat_group',
        'chat',
      ]);
      expect(composable.results.value[0]).toMatchObject({
        type: 'chat_group',
        item: { groupId: 'group1' },
      });
      expect(composable.results.value[1]).toMatchObject({
        type: 'chat',
        item: { chatId: 'chat1' },
      });
      expect(mockCreateGlobalSearchWorkerClient).not.toHaveBeenCalled();
    },
  );

  it.each(['title_only', 'all', 'current_thread'] as const)(
    'should apply the chat filter to an empty query in %s scope',
    async (scope) => {
      const composable = await createComposable();
      sidebarItems.value = [
        { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', updatedAt: 100 } },
        { id: 'chat2', type: 'chat', chat: { id: 'chat2', title: 'Chat 2', updatedAt: 200 } },
      ] as never;

      await composable.search({
        searchQuery: '',
        options: { scope, chatId: 'chat2' },
      });

      expect(composable.results.value).toHaveLength(1);
      expect(composable.results.value[0]).toMatchObject({
        type: 'chat',
        item: { chatId: 'chat2' },
      });
      expect(mockCreateGlobalSearchWorkerClient).not.toHaveBeenCalled();
    },
  );

  it('should publish title results before a content search completes', async () => {
    let resolveContentSearch: ((value: { matches: [] }) => void) | undefined;
    const searchChatContent = vi.fn(() => new Promise<{ matches: [] }>(resolve => {
      resolveContentSearch = resolve;
    }));
    mockCreateGlobalSearchWorkerClient.mockResolvedValue({
      searchChatContent,
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Hello', updatedAt: 100 } },
    ] as never;

    const searchPromise = composable.search({
      searchQuery: 'hello',
      options: { scope: 'all' },
    });

    expect(composable.results.value).toHaveLength(1);
    expect(composable.results.value[0]).toMatchObject({
      type: 'chat',
      item: { chatId: 'chat1', matchType: 'title' },
    });

    await vi.waitFor(() => {
      expect(searchChatContent).toHaveBeenCalledTimes(1);
    });
    resolveContentSearch?.({ matches: [] });
    await searchPromise;
  });

  it('should clear query and results when clearSearch is called', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never;

    await composable.search({ searchQuery: 'test', options: { scope: 'title_only' } });

    composable.clearSearch();

    expect(composable.query.value).toBe('');
    expect(composable.results.value).toEqual([]);
  });

  it('should invalidate cache but preserve query/results when stopSearch is called', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never;

    vi.mocked(storageService.loadChatContentWithoutAttachments).mockResolvedValue({ root: { items: [] } } as never);

    await composable.search({ searchQuery: 'test', options: { scope: 'all' } });
    expect(composable.query.value).toBe('test');
    expect(composable.results.value).toHaveLength(1);
    expect(storageService.loadChatContentWithoutAttachments).toHaveBeenCalledTimes(1);

    composable.stopSearch();
    expect(composable.query.value).toBe('test');
    expect(composable.results.value).toHaveLength(1);

    await composable.search({ searchQuery: 'test', options: { scope: 'all' } });
    expect(storageService.loadChatContentWithoutAttachments).toHaveBeenCalledTimes(2);
  });

  it('stopSearch should dispose the current worker client', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    mockCreateGlobalSearchWorkerClient.mockResolvedValue({
      searchChatContent: vi.fn().mockResolvedValue({ matches: [] }),
      dispose,
    });
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never;
    vi.mocked(storageService.loadChatContentWithoutAttachments).mockResolvedValue({ root: { items: [] } } as never);

    await composable.search({ searchQuery: 'test', options: { scope: 'all' } });
    composable.stopSearch();
    await Promise.resolve();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledWith();
  });

  it('should recreate the worker and rerun an active search after storage migration', async () => {
    const composable = await createComposable();
    sidebarItems.value = [
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never;
    vi.mocked(storageService.loadChatContentWithoutAttachments).mockResolvedValue({ root: { items: [] } } as never);

    await composable.search({ searchQuery: 'test', options: { scope: 'all' } });
    expect(mockCreateGlobalSearchWorkerClient).toHaveBeenLastCalledWith({ storageType: 'memory' });

    vi.mocked(storageService.getCurrentType).mockReturnValue('local');
    for (const listener of storageChangeListeners) {
      listener({ event: { type: 'migration', timestamp: Date.now() } });
    }

    await vi.waitFor(() => {
      expect(mockCreateGlobalSearchWorkerClient).toHaveBeenLastCalledWith({ storageType: 'local' });
    });
  });


});
