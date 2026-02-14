import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChat } from './useChat';
import { nextTick } from 'vue';

// Mock storage
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    loadChatMeta: vi.fn(),
    loadChatContent: vi.fn().mockResolvedValue(null),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    deleteChat: vi.fn(),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    updateChatMeta: vi.fn().mockResolvedValue(undefined),
    updateChatContent: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
  },
}));

// Mock settings
vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local', defaultModelId: 'gpt-4' } },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

// Mock LLM
let onChunkCallback: (chunk: string) => void;
vi.mock('../services/llm', () => {
  class MockOpenAI {
    chat = vi.fn().mockImplementation(async (params: { onChunk: (c: string) => void }) => {
      onChunkCallback = params.onChunk;
      return new Promise<void>(() => {});
    });
    listModels = vi.fn().mockResolvedValue([]);
  }
  return {
    OpenAIProvider: MockOpenAI,
    OllamaProvider: vi.fn(),
  };
});

describe('useChat Reactivity', () => {
  const chatStore = useChat();

  beforeEach(() => {
    vi.clearAllMocks();
    chatStore.__testOnly.clearLiveChatRegistry();
  });

  it('should reflect streamed chunks in activeMessages immediately', async () => {
    await chatStore.createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chat = chatStore.currentChat.value!;

    // Start sending
    void chatStore.sendMessage('Hello');

    // Wait for activeGenerations to have the chat (signals generation started)
    await vi.waitUntil(() => chatStore.__testOnly.activeGenerations.has(chat.id), { timeout: 2000 });

    expect(chatStore.activeMessages.value).toHaveLength(2);
    expect(chatStore.activeMessages.value[1]?.content).toBe('');

    // Simulate chunk
    onChunkCallback('A');
    await nextTick();
    expect(chatStore.activeMessages.value[1]?.content).toBe('A');

    onChunkCallback('B');
    await nextTick();
    expect(chatStore.activeMessages.value[1]?.content).toBe('AB');
  });
});