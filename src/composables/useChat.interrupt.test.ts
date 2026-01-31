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

describe('useChat Interruption', () => {
  const chatStore = useChat();
  const { __testOnly: { __testOnlySetCurrentChat } } = chatStore;

  beforeEach(() => {
    vi.clearAllMocks();
    chatStore.__testOnly.clearLiveChatRegistry();
  });

  it('should interrupt current generation and start new one when regenerateMessage is called', async () => {
    const { sendMessage, regenerateMessage, streaming } = chatStore;

    const chat = reactive({
      id: 'regen-interrupt-test',
      title: 'Regen Interrupt',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat(chat);

    // 1. Start a slow generation
    let firstGenAborted = false;
    mockLlmChat.mockImplementationOnce(async (params: { onChunk: (c: string) => void, signal: AbortSignal }) => {
      const { onChunk, signal } = params;
      signal.addEventListener('abort', () => {
        firstGenAborted = true;
      });
      if (signal.aborted) {
        firstGenAborted = true;
        return;
      }
      onChunk('First chunk');
      await new Promise(resolve => setTimeout(resolve, 100));
      if (signal.aborted) {
        firstGenAborted = true;
        return;
      }
      onChunk('Second chunk');
    });

    const sendSuccess = await sendMessage('Hello');
    expect(sendSuccess).toBe(true);
    
    // Wait for it to start streaming
    await vi.waitUntil(() => streaming.value);
    
    const userMsg = chat.root.items[0];
    const firstAssistantMsgId = userMsg.replies.items[0].id;

    // 2. Call regenerate while first one is still running
    mockLlmChat.mockImplementationOnce(async (params: { onChunk: (c: string) => void }) => {
      params.onChunk('Second Response');
    });

    await regenerateMessage(firstAssistantMsgId);

    // Expect first generation to be aborted
    expect(firstGenAborted).toBe(true);

    // Expect a second assistant message to be created
    expect(userMsg.replies.items).toHaveLength(2);
    
    // Wait for second generation to finish
    await vi.waitUntil(() => !streaming.value);

    const secondAssistantMsg = userMsg.replies.items[1];
    expect(secondAssistantMsg.content).toBe('Second Response');
    expect(chat.currentLeafId).toBe(secondAssistantMsg.id);
  });

  it('should interrupt current generation and start new one when editMessage (resend) is called', async () => {
    const { sendMessage, editMessage, streaming } = chatStore;

    const chat = reactive({
      id: 'edit-interrupt-test',
      title: 'Edit Interrupt',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat(chat);

    // 1. Start a slow generation
    let firstGenAborted = false;
    mockLlmChat.mockImplementationOnce(async (params: { onChunk: (c: string) => void, signal: AbortSignal }) => {
      const { onChunk, signal } = params;
      signal.addEventListener('abort', () => {
        firstGenAborted = true;
      });
      onChunk('First chunk');
      await new Promise(resolve => setTimeout(resolve, 100));
      if (signal.aborted) return;
      onChunk('Second chunk');
    });

    await sendMessage('Hello');
    await vi.waitUntil(() => streaming.value);
    
    const userMsg = chat.root.items[0];

    // 2. Call editMessage (resend) while first one is still running
    mockLlmChat.mockImplementationOnce(async (params: { onChunk: (c: string) => void }) => {
      params.onChunk('Edited Response');
    });

    await editMessage(userMsg.id, 'Hello Again');

    // Expect first generation to be aborted
    expect(firstGenAborted).toBe(true);

    // Wait for second generation to finish
    await vi.waitUntil(() => !streaming.value);

    // Initial 'Hello' and new 'Hello Again'
    expect(chat.root.items).toHaveLength(2);
    
    const secondAssistantMsg = chat.root.items[1].replies.items[0];
    expect(secondAssistantMsg.content).toBe('Edited Response');
  });
});
