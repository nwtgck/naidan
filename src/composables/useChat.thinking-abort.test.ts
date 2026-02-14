import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, reactive } from 'vue';
import { useChat } from './useChat';

// Mock useSettings
vi.mock('./useSettings', () => ({
  useSettings: vi.fn().mockReturnValue({
    settings: ref({
      endpointType: 'openai',
      endpointUrl: 'http://localhost:11434/v1',
      defaultModelId: 'gpt-4',
      autoTitleEnabled: true,
    }),
    setHeavyContentAlertDismissed: vi.fn(),
    setOnboardingDraft: vi.fn(),
    setIsOnboardingDismissed: vi.fn(),
  }),
}));

// Mock LLM providers
const mockLlmChat = vi.fn();
vi.mock('../services/llm', () => ({
  OpenAIProvider: class {
    chat = mockLlmChat;
    listModels = vi.fn().mockResolvedValue(['gpt-4']);
  },
  OllamaProvider: class {
    chat = vi.fn();
    listModels = vi.fn().mockResolvedValue([]);
  },
}));

// Mock storage service
vi.mock('../services/storage', () => ({
  storageService: {
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    updateChatContent: vi.fn().mockResolvedValue(undefined),
    updateChatMeta: vi.fn().mockResolvedValue(undefined),
    updateHierarchy: vi.fn().mockResolvedValue(undefined),
    subscribeToChanges: vi.fn(),
    notify: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getFile: vi.fn(),
    canPersistBinary: true,
  },
}));

describe('useChat Thinking Abort', () => {
  const chatStore = useChat();
  const { __testOnly: { __testOnlySetCurrentChat } } = chatStore;

  beforeEach(() => {
    vi.clearAllMocks();
    chatStore.__testOnly.clearLiveChatRegistry();
  });

  it('should close thinking tag and process thinking when aborted during thinking', async () => {
    const { sendMessage, abortChat, streaming } = chatStore;

    const chat = reactive({
      id: 'abort-thinking-test',
      title: 'Abort Thinking',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat(chat);

    mockLlmChat.mockImplementationOnce(async (params: { onChunk: (c: string) => void, signal: AbortSignal }) => {
      const { onChunk, signal } = params;
      onChunk('<think>I am thinking...');

      // Wait for abort
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    await sendMessage('Hello');

    // Wait for it to start streaming
    await vi.waitUntil(() => streaming.value);

    const userMsg = chat.root.items[0];
    const assistantMsg = userMsg.replies.items[0];
    expect(assistantMsg.content).toBe('<think>I am thinking...');

    // Abort it
    abortChat(chat.id);

    // Wait for the abort to be processed (content updated)
    await vi.waitUntil(() => assistantMsg.content.includes('[Generation Aborted]'));
    expect(streaming.value).toBe(false);

    // Expect thinking tag to be closed and processed
    // If it's processed, assistantMsg.thinking should be set and <think> removed from content
    expect(assistantMsg.thinking).toContain('I am thinking...');
    expect(assistantMsg.content).not.toContain('<think>');
    expect(assistantMsg.content).toContain('[Generation Aborted]');
  });
});
