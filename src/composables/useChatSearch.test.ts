import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { storageService } from '@/services/storage'

const {
  mockCreateGlobalSearchWorkerClient,
  listenerState,
} = vi.hoisted(() => ({
  mockCreateGlobalSearchWorkerClient: vi.fn(),
  listenerState: {
    current: undefined as (() => void) | undefined,
  },
}))

vi.mock('../services/storage', () => ({
  storageService: {
    getSidebarStructure: vi.fn(),
    loadChatContent: vi.fn(),
    subscribeToChanges: vi.fn((listener: () => void) => {
      listenerState.current = listener
      return () => {}
    }),
  },
}))

vi.mock('@/services/global-search-worker-client', () => ({
  createGlobalSearchWorkerClient: mockCreateGlobalSearchWorkerClient,
}))

async function createComposable() {
  const { useChatSearch } = await import('./useChatSearch')
  return useChatSearch()
}

describe('useChatSearch Composable', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    mockCreateGlobalSearchWorkerClient.mockImplementation(async () => {
      const { createGlobalSearchWorker } = await import('@/services/global-search.worker.impl')
      const worker = createGlobalSearchWorker({})

      return {
        prepareSession({ request }: { request: import('@/services/global-search.worker.types').GlobalSearchWorkerPrepareSessionRequest }) {
          return worker.prepareSession({ request })
        },
        searchTitles({ request }: { request: import('@/services/global-search.worker.types').GlobalSearchWorkerSearchTitlesRequest }) {
          return worker.searchTitles({ request })
        },
        searchChatContent({ request }: { request: import('@/services/global-search.worker.types').GlobalSearchWorkerSearchChatContentRequest }) {
          return worker.searchChatContent({ request })
        },
        disposeSession({ request }: { request: import('@/services/global-search.worker.types').GlobalSearchWorkerDisposeSessionRequest }) {
          return worker.disposeSession({ request })
        },
        dispose: vi.fn().mockResolvedValue(undefined),
      }
    })
  })

  it('should skip search if trimmed query is the same', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never)

    await composable.search({ searchQuery: 'test', options: { scope: 'title_only' } })
    await composable.search({ searchQuery: 'test ', options: { scope: 'title_only' } })

    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(1)
  })

  it('should rerun search when scope changes for the same trimmed query', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Hello World', updatedAt: 100 } },
    ] as never)
    vi.mocked(storageService.loadChatContent).mockResolvedValue({
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
    } as never)

    await composable.search({ searchQuery: 'hello', options: { scope: 'title_only' } })
    expect(composable.results.value).toHaveLength(1)
    expect(storageService.loadChatContent).not.toHaveBeenCalled()

    await composable.search({ searchQuery: 'hello', options: { scope: 'all' } })
    expect(storageService.loadChatContent).toHaveBeenCalledWith('chat1')
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(1)
  })

  it('should manage isScanningContent flag', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never)
    vi.mocked(storageService.loadChatContent).mockResolvedValue({ root: { items: [] } } as never)

    const promise = composable.search({ searchQuery: 'test', options: { scope: 'all' } })
    await nextTick()
    await promise

    expect(composable.isScanningContent.value).toBe(false)
  })

  it('should match by group name independently', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
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
    ] as never)

    await composable.search({ searchQuery: 'Work', options: { scope: 'title_only' } })

    expect(composable.results.value).toHaveLength(1)
    const first = composable.results.value[0]
    expect(first?.type).toBe('chat_group')
  })

  it('should match "new chat" for null titles', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: null, updatedAt: 100 } },
    ] as never)

    await composable.search({ searchQuery: 'new chat', options: { scope: 'title_only' } })

    expect(composable.results.value).toHaveLength(1)
    expect(composable.results.value[0]?.type).toBe('chat')
  })

  it('should preserve raw query with spaces but search with trimmed version', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never)

    await composable.search({ searchQuery: 'test  ', options: { scope: 'title_only' } })

    expect(composable.query.value).toBe('test  ')
    expect(composable.results.value).toHaveLength(1)
  })

  it('should filter content scanning by chatGroupIds', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
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
    ] as never)
    vi.mocked(storageService.loadChatContent).mockResolvedValue({ root: { items: [] } } as never)

    await composable.search({
      searchQuery: 'test',
      options: { scope: 'all', chatGroupIds: ['group1'] },
    })

    expect(storageService.loadChatContent).toHaveBeenCalledWith('chat1')
    expect(storageService.loadChatContent).toHaveBeenCalledWith('chat3')
    expect(storageService.loadChatContent).not.toHaveBeenCalledWith('chat2')
  })

  it('should filter by specific chatId', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Chat 1', updatedAt: 100 } },
      { id: 'chat2', type: 'chat', chat: { id: 'chat2', title: 'Chat 2', updatedAt: 200 } },
    ] as never)
    vi.mocked(storageService.loadChatContent).mockResolvedValue({ root: { items: [] } } as never)

    await composable.search({
      searchQuery: 'test',
      options: { scope: 'all', chatId: 'chat2' },
    })

    expect(storageService.loadChatContent).toHaveBeenCalledWith('chat2')
    expect(storageService.loadChatContent).not.toHaveBeenCalledWith('chat1')
  })

  it('should set matchType to both if keywords match in both title and content', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Hello World', updatedAt: 100 } },
    ] as never)
    vi.mocked(storageService.loadChatContent).mockResolvedValue({
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
    } as never)

    await composable.search({ searchQuery: 'hello', options: { scope: 'all' } })

    expect(composable.results.value).toHaveLength(2)
    const first = composable.results.value[0]
    expect(first?.type).toBe('chat')
    if (first?.type === 'chat') {
      expect(first.item.matchType).toBe('both')
      expect(first.item.contentMatches).toHaveLength(1)
    }
  })

  it('should handle AND search keywords in titles', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Hello World Test', updatedAt: 100 } },
      { id: 'chat2', type: 'chat', chat: { id: 'chat2', title: 'Hello World', updatedAt: 200 } },
    ] as never)

    await composable.search({
      searchQuery: 'hello test',
      options: { scope: 'title_only' },
    })

    expect(composable.results.value).toHaveLength(1)
    const first = composable.results.value[0]
    expect(first?.type).toBe('chat')
    if (first?.type === 'chat') {
      expect(first.item.chatId).toBe('chat1')
    }
  })

  it('should include groupName in chat results', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
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
    ] as never)

    await composable.search({ searchQuery: 'Chat', options: { scope: 'title_only' } })

    const first = composable.results.value[0]
    expect(first?.type).toBe('chat')
    if (first?.type === 'chat') {
      expect(first.item.groupName).toBe('Work')
    }
  })

  it('should prioritize items by sidebar order', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
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
    ] as never)

    await composable.search({ searchQuery: 'e', options: { scope: 'title_only' } })

    expect(composable.results.value).toHaveLength(2)
    expect(composable.results.value[0]?.type).toBe('chat_group')
    expect(composable.results.value[1]?.type).toBe('chat')
  })

  it('should list all groups and chats if query is empty and scope is title_only', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
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
    ] as never)

    await composable.search({ searchQuery: '', options: { scope: 'title_only' } })

    expect(composable.results.value).toHaveLength(2)
    expect(composable.results.value[0]?.type).toBe('chat_group')
    expect(composable.results.value[1]?.type).toBe('chat')
  })

  it('should clear sidebar cache when clearSearch is called', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never)

    await composable.search({ searchQuery: 'test', options: { scope: 'title_only' } })
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(1)

    await composable.search({ searchQuery: 'tes', options: { scope: 'title_only' } })
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(1)

    composable.clearSearch()

    await composable.search({ searchQuery: 'test', options: { scope: 'title_only' } })
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(2)
  })

  it('should invalidate cache but preserve query/results when stopSearch is called', async () => {
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([
      { id: 'chat1', type: 'chat', chat: { id: 'chat1', title: 'Test', updatedAt: 100 } },
    ] as never)

    await composable.search({ searchQuery: 'test', options: { scope: 'title_only' } })
    expect(composable.query.value).toBe('test')
    expect(composable.results.value).toHaveLength(1)
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(1)

    composable.stopSearch()
    expect(composable.query.value).toBe('test')
    expect(composable.results.value).toHaveLength(1)

    await composable.search({ searchQuery: 'test', options: { scope: 'title_only' } })
    expect(storageService.getSidebarStructure).toHaveBeenCalledTimes(2)
  })

  it('stopSearch should dispose the current worker client', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined)
    mockCreateGlobalSearchWorkerClient.mockResolvedValue({
      prepareSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      searchTitles: vi.fn().mockResolvedValue({ flatResults: [] }),
      searchChatContent: vi.fn().mockResolvedValue({ matches: [] }),
      disposeSession: vi.fn().mockResolvedValue(undefined),
      dispose,
    })
    const composable = await createComposable()
    vi.mocked(storageService.getSidebarStructure).mockResolvedValue([] as never)

    await composable.search({ searchQuery: '', options: { scope: 'title_only' } })
    composable.stopSearch()
    await Promise.resolve()
    await Promise.resolve()

    expect(dispose).toHaveBeenCalledWith({})
  })
})
