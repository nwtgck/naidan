import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { useSettings } from './useSettings';
import { reactive, nextTick } from 'vue';

// Mock storage
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    saveChat: vi.fn().mockResolvedValue(undefined),
    saveChatMeta: vi.fn(),
    saveChatContent: vi.fn(),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    loadChat: vi.fn(),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    updateSettings: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
  },
}));

const mockOpenAIChat = vi.fn();
const mockOllamaChat = vi.fn();
const mockOpenAIModels = vi.fn();
const mockOllamaModels = vi.fn();

// Proper class mocking for Vitest
vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: vi.fn().mockImplementation(function() {
      return {
        chat: mockOpenAIChat,
        listModels: mockOpenAIModels,
      };
    }),
    OllamaProvider: vi.fn().mockImplementation(function() {
      return {
        chat: mockOllamaChat,
        listModels: mockOllamaModels,
      };
    }),
  };
});

describe('useChat Settings Resolution Policy', () => {
  const { settings } = useSettings();
  const { sendMessage, currentChat } = useChat();

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default Global Settings
    settings.value = {
      endpointType: 'openai',
      endpointUrl: 'http://global-openai',
      defaultModelId: 'global-gpt',
      autoTitleEnabled: false,
      storageType: 'local',
      providerProfiles: [],
    };

    mockOpenAIModels.mockResolvedValue(['global-gpt', 'other-gpt', 'pinned-model', 'model-a', 'model-b']);
    mockOllamaModels.mockResolvedValue(['llama-global', 'llama-other']);
    
    mockOpenAIChat.mockImplementation(async (_msg, _model, _url, onChunk) => onChunk('OpenAI Resp'));
    mockOllamaChat.mockImplementation(async (_msg, _model, _url, onChunk) => onChunk('Ollama Resp'));
    
    currentChat.value = null;
  });

  it('Scenario: Global setting change should be reflected in existing chat for subsequent messages', async () => {
    // 1. Setup with Setting A
    settings.value.endpointUrl = 'http://endpoint-a';
    settings.value.defaultModelId = 'global-gpt';
    
    currentChat.value = reactive({
      id: 'chat-scenario', title: 'Scenario Test', root: { items: [] },
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    });

    // Send first message using Global A
    await sendMessage('Message 1');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.anything(), 'global-gpt', 'http://endpoint-a', expect.anything(), expect.anything(), undefined, expect.anything());

    // 2. Change to Setting B
    settings.value.endpointUrl = 'http://endpoint-b';
    settings.value.defaultModelId = 'model-b';

    // Send second message in SAME chat - should now use Global B
    await sendMessage('Message 2');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.anything(), 'model-b', 'http://endpoint-b', expect.anything(), expect.anything(), undefined, expect.anything());
    
    // 3. Verify that the chat object itself didn't "lock in" model-b
    expect(currentChat.value.modelId).toBeUndefined();
  });

  it('Policy: Prioritize chat-level modelId (Pinning)', async () => {
    currentChat.value = reactive({
      id: 'chat-2', title: 'Pinned Model Chat', root: { items: [] },
      modelId: 'pinned-model',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    });

    await sendMessage('M1');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.anything(), 'pinned-model', 'http://global-openai', expect.anything(), expect.anything(), undefined, expect.anything());

    // Change global model - should NOT affect pinned chat
    settings.value.defaultModelId = 'new-global-gpt';
    await sendMessage('M2');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.anything(), 'pinned-model', 'http://global-openai', expect.anything(), expect.anything(), undefined, expect.anything());
  });

  it('Policy: Respect chat-level endpoint settings while following global model if not pinned', async () => {
    currentChat.value = reactive({
      id: 'chat-3', title: 'Pinned Endpoint Chat', root: { items: [] },
      endpointType: 'ollama' as const,
      endpointUrl: 'http://pinned-ollama',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    });

    // Global is OpenAI, but chat endpoint is Ollama. Model should be llama-global because Ollama list results in llama-global
    await sendMessage('M1');
    expect(mockOllamaChat).toHaveBeenLastCalledWith(expect.anything(), 'llama-global', 'http://pinned-ollama', expect.anything(), expect.anything(), undefined, expect.anything());

    // Change global model to something available in Ollama
    settings.value.defaultModelId = 'llama-other';
    await sendMessage('M2');
    expect(mockOllamaChat).toHaveBeenLastCalledWith(expect.anything(), 'llama-other', 'http://pinned-ollama', expect.anything(), expect.anything(), undefined, expect.anything());
  });

  it('Policy: Dynamic resolution when preferred model is unavailable', async () => {
    currentChat.value = reactive({
      id: 'chat-4', title: 'Fallback Chat', root: { items: [] },
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    });

    settings.value.defaultModelId = 'non-existent';
    mockOpenAIModels.mockResolvedValue(['first-available', 'second']);

    await sendMessage('M1');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.anything(), 'first-available', 'http://global-openai', expect.anything(), expect.anything(), undefined, expect.anything());
  });

  it('Policy: Resolve headers hierarchically (Chat > Global)', async () => {
    // 1. Global only
    settings.value.endpointHttpHeaders = [['X-Global', '1']];
    currentChat.value = reactive({
      id: 'chat-h', title: 'Header Test', root: { items: [] },
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    });

    await sendMessage('G');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.anything(), expect.any(String), expect.any(String), expect.anything(), expect.anything(), [['X-Global', '1']], expect.anything());

    // 2. Chat Override
    currentChat.value.endpointHttpHeaders = [['X-Chat', '3']];
    await sendMessage('C');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.anything(), expect.any(String), expect.any(String), expect.anything(), expect.anything(), [['X-Chat', '3']], expect.anything());
  });

  it('Policy: Hierarchy Resolution (Chat > Group > Global) in resolvedSettings metadata', async () => {
    const { currentChat, rootItems, resolvedSettings } = useChat();
    
    // 1. Initial State: Global Default
    currentChat.value = reactive({
      id: 'chat-hr', title: 'Hierarchy Test', root: { items: [] },
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    });

    expect(resolvedSettings.value?.modelId).toBe('global-gpt');
    expect(resolvedSettings.value?.sources.modelId).toBe('global');

    // 2. Add Group Default
    const group = reactive({
      id: 'g1', name: 'Group 1', items: [], updatedAt: Date.now(), isCollapsed: false,
      modelId: 'group-model'
    }) as any;
    rootItems.value = [{ id: 'chat_group:g1', type: 'chat_group', chatGroup: group }];
    currentChat.value.groupId = 'g1';
    await nextTick();

    expect(resolvedSettings.value?.modelId).toBe('group-model');
    expect(resolvedSettings.value?.sources.modelId).toBe('chat_group');

    // 3. Add Chat Override
    currentChat.value.modelId = 'chat-model';
    await nextTick();
    expect(resolvedSettings.value?.modelId).toBe('chat-model');
    expect(resolvedSettings.value?.sources.modelId).toBe('chat');

    // 4. Remove Chat Override -> Should go back to Group
    currentChat.value.modelId = undefined;
    await nextTick();
    expect(resolvedSettings.value?.modelId).toBe('group-model');
    expect(resolvedSettings.value?.sources.modelId).toBe('chat_group');

    // 5. Remove Group Override -> Should go back to Global
    group.modelId = undefined;
    await nextTick();
    expect(resolvedSettings.value?.modelId).toBe('global-gpt');
    expect(resolvedSettings.value?.sources.modelId).toBe('global');
  });
});