import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChat } from './useChat';
import { ref, nextTick } from 'vue';

// --- Mocks ---

const mockSaveChat = vi.fn().mockResolvedValue(undefined);
const mockLoadChat = vi.fn().mockResolvedValue(null);

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    saveChat: (...args: any[]) => mockSaveChat(...args),
    updateChatMeta: vi.fn(), loadChatMeta: vi.fn().mockResolvedValue(undefined),
    updateChatContent: vi.fn().mockImplementation((_id, updater) => Promise.resolve(updater(null))).mockResolvedValue(undefined),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    loadChat: (...args: any[]) => mockLoadChat(...args),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    updateChatGroup: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
    deleteChat: vi.fn(),
    deleteChatGroup: vi.fn(),
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
    async listModels() { return []; }
  },
}));

describe('useChat Registry Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLlmChat.mockReset().mockResolvedValue(undefined);
    mockListModels.mockReset().mockResolvedValue(['gpt-4']);
    mockLoadChat.mockReset().mockResolvedValue(null);
  });

  it('should keep chat in liveChatRegistry until ALL background tasks are finished', async () => {
    const { createNewChat, sendMessage, fetchAvailableModels, currentChat, openChat, activeGenerations } = useChat();
    
    // Ensure we start clean
    activeGenerations.clear();

    await createNewChat();
    const chat = currentChat.value!;
    const chatId = chat.id;

    // Helper to check registry presence indirectly
    const checkRegistry = async () => {
      const prev = currentChat.value;
      currentChat.value = null;
      await openChat(chatId);
      const exists = currentChat.value === chat;
      currentChat.value = prev;
      return exists;
    };
    
    // 1. Start fetch models (long running)
    let resolveModels: (v: string[]) => void;
    const modelPromise = new Promise<string[]>(r => resolveModels = r);
    mockListModels.mockReturnValue(modelPromise);
    
    const fetchTask = fetchAvailableModels(chat);
    
    // Wait for the registry to populate via fetchAvailableModels
    await vi.waitUntil(checkRegistry, { timeout: 1000 });
    expect(await checkRegistry()).toBe(true);
    
    // 2. Start sendMessage (which also awaits fetchAvailableModels)
    let resolveChat: () => void;
    const chatPromise = new Promise<void>(r => resolveChat = r);
    mockLlmChat.mockReturnValue(chatPromise);
    
    const sendTask = sendMessage('Hello');
    
    // 3. Resolve model fetch
    // This will finish fetchTask and allow sendTask to proceed to generateResponse
    resolveModels!(['m1']);
    await fetchTask;
    
    // Give sendMessage time to reach generateResponse
    await vi.waitUntil(() => activeGenerations.has(chatId), { timeout: 1000 });
    
    // Should STILL be in registry because sendMessage is now generating
    expect(await checkRegistry()).toBe(true);
    
    // 4. Resolve generation
    resolveChat!();
    
    // Title gen also uses mockLlmChat, make it resolve immediately
    mockLlmChat.mockResolvedValue(undefined);
    
    await sendTask;
    
    // Wait for everything to settle
    await flushPromises();
    await nextTick();
    
    // Now it should be gone from registry
    mockLoadChat.mockResolvedValue(JSON.parse(JSON.stringify(chat)));
    
    currentChat.value = null;
    await openChat(chatId);
    expect(mockLoadChat).toHaveBeenCalledWith(chatId);
    expect(currentChat.value).not.toBe(chat); 
  });

  it('should not leak newly created chats in liveChatRegistry after creation is complete', async () => {
    const { createNewChat, currentChat, openChat } = useChat();
    
    await createNewChat();
    const chat = currentChat.value!;
    const chatId = chat.id;
    
    // Switch away to ensure it's not kept alive by currentChat
    currentChat.value = null;
    
    // If it's leaked in registry, openChat will return the same instance
    // If NOT leaked, it will call storageService.loadChat
    mockLoadChat.mockResolvedValue(JSON.parse(JSON.stringify(chat)));
    
    await openChat(chatId);
    
    // THIS IS EXPECTED TO FAIL IF THERE IS A LEAK
    expect(mockLoadChat).toHaveBeenCalledWith(chatId);
    expect(currentChat.value).not.toBe(chat);
  });
});

async function flushPromises() {
  return new Promise(resolve => setTimeout(resolve, 0));
}