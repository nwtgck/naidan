import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from './useChat';

const chats = new Map<string, any>();
const mockListModels = vi.fn();
const mockUpdateChatContent = vi.fn().mockImplementation(async ({ updater }: { id: string; updater: ({ current }: { current: unknown }) => unknown }) => {
  return await updater({ current: null });
});

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
    loadChatGroup: vi.fn().mockResolvedValue(null),
    loadChatMeta: vi.fn().mockImplementation(async ({ id }: { id: string }) => chats.get(id) ?? null),
    loadChatContent: vi.fn().mockResolvedValue(null),
    loadChat: vi.fn().mockImplementation(async ({ id }: { id: string }) => chats.get(id) ?? null),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    updateHierarchy: vi.fn().mockImplementation(async ({ updater }: { updater: ({ current }: { current: { items: never[] } }) => { items: never[] } }) => updater({ current: { items: [] } })),
    updateChatContent: (...args: Parameters<typeof mockUpdateChatContent>) => mockUpdateChatContent(...args),
    updateChatMeta: vi.fn().mockImplementation(async ({ id, updater }: { id: string; updater: ({ current }: { current: unknown }) => Promise<unknown> | unknown }) => {
      const updated = await updater({ current: chats.get(id) ?? null });
      chats.set(id, updated);
    }),
    deleteChat: vi.fn(),
    deleteChatGroup: vi.fn(),
    notify: vi.fn(),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: {
      value: {
        endpointType: 'openai',
        endpointUrl: 'http://localhost',
        storageType: 'local',
        defaultModelId: 'gpt-4',
      },
    },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

vi.mock('../services/lm/openai', () => ({
  OpenAIProvider: class {
    chat = vi.fn();
    listModels = mockListModels;
  },
}));

vi.mock('../services/lm/ollama', () => ({
  OllamaProvider: class {
    async listModels() {
      return [];
    }
  },
}));

describe('useChat shared state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chats.clear();
    mockListModels.mockResolvedValue(['gpt-4.1', 'o4-mini']);
    mockUpdateChatContent.mockImplementation(async ({ updater }: { id: string; updater: ({ current }: { current: unknown }) => unknown }) => {
      return await updater({ current: null });
    });

    const chatStore = useChat();
    chatStore.availableModels.value = [];
    chatStore.TEST_ONLY.__testOnlySetCurrentChat({ chat: null });
    chatStore.TEST_ONLY.__testOnlySetCurrentChatGroup({ group: null });
    chatStore.TEST_ONLY.clearLiveChatRegistry({});
    chatStore.TEST_ONLY.clearActiveTaskCounts({});
  });

  it('shares availableModels across useChat callers', async () => {
    const storeA = useChat();
    const storeB = useChat();

    expect(storeA.availableModels).toBe(storeB.availableModels);

    await storeA.fetchAvailableModels({
      chatId: undefined,
      customEndpoint: undefined,
    });

    expect(storeA.availableModels.value).toEqual(['gpt-4.1', 'o4-mini']);
    expect(storeB.availableModels.value).toEqual(['gpt-4.1', 'o4-mini']);
  });

  it('shares the createNewChat guard across useChat callers', async () => {
    let releaseCreateChat: (() => void) | undefined;
    const createChatBlocked = new Promise<void>(resolve => {
      releaseCreateChat = resolve;
    });
    mockUpdateChatContent.mockImplementationOnce(async ({ updater }: { id: string; updater: ({ current }: { current: unknown }) => unknown }) => {
      await createChatBlocked;
      return await updater({ current: null });
    });

    const storeA = useChat();
    const storeB = useChat();

    const firstCreatePromise = storeA.createNewChat({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: undefined,
    });
    await Promise.resolve();

    const secondCreateResult = await storeB.createNewChat({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: undefined,
    });

    expect(secondCreateResult).toBeNull();

    releaseCreateChat?.();
    const firstCreateResult = await firstCreatePromise;
    expect(firstCreateResult?.id).toBeDefined();
  });
});
