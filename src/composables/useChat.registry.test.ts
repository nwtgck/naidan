import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChat } from './useChat';
import { ref, nextTick, toRaw } from 'vue';

// --- Mocks ---

const chats = new Map<string, any>();
const mockSaveChat = vi.fn().mockImplementation((chat) => {
  chats.set(chat.id, JSON.parse(JSON.stringify(chat)));
  return Promise.resolve();
});
const mockLoadChat = vi.fn().mockImplementation((id) => Promise.resolve(chats.get(id) ? JSON.parse(JSON.stringify(chats.get(id))) : null));

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    saveChat: (...args: any[]) => mockSaveChat(...args),
    updateChatMeta: vi.fn().mockImplementation((id, updater) => {
      const curr = chats.get(id) || null;
      return Promise.resolve(updater(curr)).then(updated => {
        chats.set(id, JSON.parse(JSON.stringify(updated)));
      });
    }),
    loadChatMeta: vi.fn().mockImplementation((id) => Promise.resolve(chats.get(id))),
    updateChatContent: vi.fn().mockImplementation((id, updater) => {
      const curr = chats.get(id) || { root: { items: [] } };
      return Promise.resolve(updater(curr)).then(updated => {
        chats.set(id, { ...JSON.parse(JSON.stringify(chats.get(id) || {})), ...JSON.parse(JSON.stringify(updated)) });
      });
    }),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    loadChat: (...args: any[]) => mockLoadChat(...args),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    updateChatGroup: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
    deleteChat: vi.fn(),
    deleteChatGroup: vi.fn(),
    notify: vi.fn(),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: ref({ autoTitleEnabled: true, endpointUrl: 'http://localhost', endpointType: 'openai', defaultModelId: 'm1' }),
    isOnboardingDismissed: ref(true),
    onboardingDraft: ref(null),
  }),
}));

const mockLlmChat = vi.fn();
const mockListModels = vi.fn();

vi.mock('../services/llm', () => ({
  OpenAIProvider: class {
    chat = mockLlmChat;
    listModels = mockListModels;
  },
  OllamaProvider: class {
    async listModels() {
      return [];
    }
  },
}));

describe('useChat Registry Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chats.clear();
    mockLlmChat.mockReset().mockResolvedValue(undefined);
    mockListModels.mockReset().mockResolvedValue(['gpt-4']);
  });

  it('should keep chat in liveChatRegistry until ALL background tasks are finished', async () => {
    const chatStore = useChat();
    const { createNewChat, sendMessage, fetchAvailableModels, currentChat, openChat, unregisterLiveInstance, __testOnly } = chatStore;
    const { activeGenerations, liveChatRegistry, __testOnlySetCurrentChat } = __testOnly;

    // Ensure we start clean
    activeGenerations.clear();
    liveChatRegistry.clear();

    const chatObj = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chatId = chatObj?.id;
    await openChat(chatId!);
    const chat = currentChat.value!;

    // 1. Start fetch models (long running)
    let resolveModels: (v: string[]) => void;
    const modelPromise = new Promise<string[]>(r => resolveModels = r);
    mockListModels.mockReturnValue(modelPromise);

    const fetchTask = fetchAvailableModels(chat as any);

    // Wait for the registry to populate via fetchAvailableModels (using busy check)
    await vi.waitUntil(() => toRaw(chatStore.getLiveChat(chat as any)) === toRaw(chat), { timeout: 1000 });

    // 2. Start sendMessage (which also awaits fetchAvailableModels)
    let resolveChat: () => void;
    const chatPromise = new Promise<void>(r => resolveChat = r);
    mockLlmChat.mockReturnValue(chatPromise);

    const sendTask = sendMessage('Hello');

    // 3. Resolve model fetch
    resolveModels!(['m1']);
    await fetchTask;

    // Give sendMessage time to reach generateResponse
    await vi.waitUntil(() => activeGenerations.has(chatId!), { timeout: 1000 });

    // 4. Resolve generation
    resolveChat!();

    // Title gen also uses mockLlmChat, make it resolve immediately
    mockLlmChat.mockResolvedValue(undefined);

    await sendTask;

    // Wait for everything to settle
    await flushPromises();
    await nextTick();

    // VERIFY: It should NOT be in registry anymore if tasks are done and it's not current
    __testOnlySetCurrentChat(null);
    unregisterLiveInstance(chatId!);
    expect(liveChatRegistry.has(chatId!)).toBe(false);

    // Now it should be gone from registry
    mockLoadChat.mockClear();
    await openChat(chatId!);
    expect(mockLoadChat).toHaveBeenCalledWith(chatId!);
    expect(currentChat.value).not.toBe(chat);
  });

  it('should not leak newly created chats in liveChatRegistry after creation is complete', async () => {
    const { createNewChat, currentChat, openChat, unregisterLiveInstance, __testOnly } = useChat();
    const { liveChatRegistry, __testOnlySetCurrentChat } = __testOnly;
    liveChatRegistry.clear();

    const chatObj = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chatId = chatObj?.id;
    await openChat(chatId!);
    const chat = currentChat.value!;

    // Switch away to ensure it's not kept alive by currentChat
    __testOnlySetCurrentChat(null);
    unregisterLiveInstance(chatId!);

    // VERIFY: It should NOT be in registry anymore
    expect(liveChatRegistry.has(chatId!)).toBe(false);

    // If it's leaked in registry, openChat will return the same instance
    // If NOT leaked, it will call storageService.loadChat
    mockLoadChat.mockClear();
    await openChat(chatId!);

    // THIS IS EXPECTED TO FAIL IF THERE IS A LEAK
    expect(mockLoadChat).toHaveBeenCalledWith(chatId!);
    expect(currentChat.value).not.toBe(chat);
  });
});

async function flushPromises() {
  return new Promise(resolve => setTimeout(resolve, 0));
}