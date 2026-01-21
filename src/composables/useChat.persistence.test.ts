import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock LLM provider
vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: vi.fn().mockImplementation(() => ({
      chat: vi.fn().mockImplementation((_messages, _model, _url, onChunk) => {
        onChunk('Done');
        return Promise.resolve();
      }),
      listModels: vi.fn().mockResolvedValue(['gpt-4']),
    })),
    OllamaProvider: vi.fn(),
  };
});

// Mock storage service
vi.mock('../services/storage', () => ({
  storageService: {
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    updateChatContent: vi.fn().mockResolvedValue({}),
    updateChatMeta: vi.fn().mockResolvedValue({}),
    updateHierarchy: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({}),
    loadSettings: vi.fn().mockResolvedValue({}),
    notify: vi.fn(),
    subscribeToChanges: vi.fn(),
    getCurrentType: vi.fn().mockReturnValue('local'),
    init: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('useChat Persistence Timing', () => {
  let persistMock: any;
  let persistedMock: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    
    persistMock = vi.fn().mockResolvedValue(true);
    persistedMock = vi.fn().mockResolvedValue(false);

    Object.defineProperty(global.navigator, 'storage', {
      value: {
        persist: persistMock,
        persisted: persistedMock,
      },
      configurable: true,
      writable: true,
    });

    const { useSettings } = await import('./useSettings');
    const settings = useSettings();
    await settings.save({
      endpointType: 'openai',
      endpointUrl: 'http://localhost:11434',
      defaultModelId: 'gpt-4',
      autoTitleEnabled: false,
      storageType: 'local',
      providerProfiles: [],
    } as any);
  });

  it('should call navigator.storage.persist after the first assistant response', async () => {
    const { useChat } = await import('./useChat');
    const chatStore = useChat();
    const { sendMessage, createNewChat } = chatStore;
    
    await createNewChat();
    
    // First message (User -> Assistant)
    await sendMessage('Hello');
    // Wait for background generation to finish, which triggers storage.persist
    await vi.waitUntil(() => !chatStore.streaming.value);
    
    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it('should NOT call navigator.storage.persist after the second assistant response in the same chat', async () => {
    const { useChat } = await import('./useChat');
    const chatStore = useChat();
    const { sendMessage, createNewChat } = chatStore;
    
    await createNewChat();
    
    // First message
    await sendMessage('Message 1');
    await vi.waitUntil(() => !chatStore.streaming.value);
    expect(persistMock).toHaveBeenCalledTimes(1);
    
    // Second message
    await sendMessage('Message 2');
    await vi.waitUntil(() => !chatStore.streaming.value);
    expect(persistMock).toHaveBeenCalledTimes(1); // Still 1
  });

  it('should NOT call navigator.storage.persist for a new chat if already called in the session', async () => {
    const { useChat } = await import('./useChat');
    const chatStore = useChat();
    const { sendMessage, createNewChat } = chatStore;
    
    // Chat 1
    await createNewChat();
    await sendMessage('Chat 1 Message 1');
    await vi.waitUntil(() => !chatStore.streaming.value);
    expect(persistMock).toHaveBeenCalledTimes(1);
    
    // Chat 2
    await createNewChat();
    await sendMessage('Chat 2 Message 1');
    await vi.waitUntil(() => !chatStore.streaming.value);
    expect(persistMock).toHaveBeenCalledTimes(1); // Should still be 1 because of module-level session flag
  });
});
