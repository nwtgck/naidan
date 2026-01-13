import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { useSettings } from './useSettings';
import { reactive } from 'vue';

// Mock storage
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    saveChat: vi.fn().mockResolvedValue(undefined),
    loadChat: vi.fn(),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    saveSettings: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    listGroups: vi.fn().mockResolvedValue([]),
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
    settings.value.defaultModelId = 'global-gpt'; // This matches the beforeEach
    
    currentChat.value = reactive({
      id: 'chat-scenario', title: 'Scenario Test', root: { items: [] },
      modelId: '', createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    });

    // Send first message using Global A
    await sendMessage('Message 1');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.anything(), 'global-gpt', 'http://endpoint-a', expect.anything(), expect.anything(), expect.anything());

    // 2. Change to Setting B
    settings.value.endpointUrl = 'http://endpoint-b';
    settings.value.defaultModelId = 'model-b';

    // Send second message in SAME chat - should now use Global B
    await sendMessage('Message 2');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.anything(), 'model-b', 'http://endpoint-b', expect.anything(), expect.anything(), expect.anything());
    
    // 3. Verify that the chat object itself didn't "lock in" model-b
    expect(currentChat.value.modelId).toBe('');
    expect(currentChat.value.overrideModelId).toBeUndefined();
  });

  it('Policy: Prioritize chat-level overrideModelId (Pinning)', async () => {
    currentChat.value = reactive({
      id: 'chat-2', title: 'Pinned Model Chat', root: { items: [] },
      modelId: '', overrideModelId: 'pinned-model',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    });

    await sendMessage('M1');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.anything(), 'pinned-model', 'http://global-openai', expect.anything(), expect.anything(), expect.anything());

    // Change global model - should NOT affect pinned chat
    settings.value.defaultModelId = 'new-global-gpt';
    await sendMessage('M2');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.anything(), 'pinned-model', 'http://global-openai', expect.anything(), expect.anything(), expect.anything());
  });

  it('Policy: Respect chat-level endpoint settings while following global model if not pinned', async () => {
    currentChat.value = reactive({
      id: 'chat-3', title: 'Pinned Endpoint Chat', root: { items: [] },
      modelId: '', 
      endpointType: 'ollama' as const,
      endpointUrl: 'http://pinned-ollama',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    });

    // Global is OpenAI, but chat endpoint is Ollama. Model should be llama-global because Ollama list results in llama-global
    await sendMessage('M1');
    expect(mockOllamaChat).toHaveBeenLastCalledWith(expect.anything(), 'llama-global', 'http://pinned-ollama', expect.anything(), expect.anything(), expect.anything());

    // Change global model to something available in Ollama
    settings.value.defaultModelId = 'llama-other';
    await sendMessage('M2');
    expect(mockOllamaChat).toHaveBeenLastCalledWith(expect.anything(), 'llama-other', 'http://pinned-ollama', expect.anything(), expect.anything(), expect.anything());
  });

  it('Policy: Dynamic resolution when preferred model is unavailable', async () => {
    currentChat.value = reactive({
      id: 'chat-4', title: 'Fallback Chat', root: { items: [] },
      modelId: '', createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    });

    settings.value.defaultModelId = 'non-existent';
    mockOpenAIModels.mockResolvedValue(['first-available', 'second']);

    await sendMessage('M1');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.anything(), 'first-available', 'http://global-openai', expect.anything(), expect.anything(), expect.anything());
  });
});