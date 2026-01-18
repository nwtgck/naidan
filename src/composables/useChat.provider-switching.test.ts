import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { useSettings } from './useSettings';
import { reactive } from 'vue';
import type { Chat } from '../models/types';

// Mock storage
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    saveChat: vi.fn().mockResolvedValue(undefined),
    loadChat: vi.fn(),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    saveSettings: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
  },
}));

const mockOpenAIChat = vi.fn();
const mockOllamaChat = vi.fn();
const mockOpenAIModels = vi.fn();
const mockOllamaModels = vi.fn();

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

describe('Provider and Model Compatibility (Comprehensive Test)', () => {
  const { settings } = useSettings();
  const { sendMessage, currentChat } = useChat();

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset Settings
    settings.value = {
      endpointType: 'openai',
      endpointUrl: 'http://localhost:1234/v1',
      defaultModelId: 'gpt-4',
      autoTitleEnabled: false,
      storageType: 'local',
      providerProfiles: [],
    };

    mockOpenAIModels.mockResolvedValue(['gpt-4', 'gpt-3.5-turbo']);
    mockOllamaModels.mockResolvedValue(['llama3', 'mistral']);
    
    mockOpenAIChat.mockImplementation(async (_msg, _model, _url, onChunk) => onChunk('OpenAI Response'));
    mockOllamaChat.mockImplementation(async (_msg, _model, _url, onChunk) => onChunk('Ollama Response'));
    
    currentChat.value = null;
  });

  it('Scenario: Full lifecycle of a chat through multiple provider and model changes', async () => {
    const chatObj: Chat = {
      id: 'integration-test',
      title: 'Mega Test',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    };
    currentChat.value = reactive(chatObj);

    // 1. OpenAI (gpt-4-showcase -> resolves to gpt-4)
    await sendMessage('M1');
    expect(mockOpenAIChat.mock.calls[0]![1]).toBe('gpt-4');

    // 2. Ollama (gpt-4-showcase -> resolves to llama3)
    settings.value.endpointType = 'ollama';
    await sendMessage('M2');
    expect(mockOllamaChat.mock.calls[0]![1]).toBe('llama3');

    // 3. Custom Override (gpt-3.5-turbo)
    currentChat.value.endpointType = 'openai';
    currentChat.value.modelId = 'gpt-3.5-turbo';
    await sendMessage('M3');
    expect(mockOpenAIChat.mock.calls[1]![1]).toBe('gpt-3.5-turbo');
  });

  it('should fallback to first available model if defaultModelId is also missing', async () => {
    settings.value.endpointType = 'ollama';
    settings.value.defaultModelId = 'missing-default';
    mockOllamaModels.mockResolvedValue(['first-available', 'second']);

    currentChat.value = reactive({
      id: 'fallback-test',
      title: 'Fallback Test',
      root: { items: [] },
      createdAt: 0, updatedAt: 0, debugEnabled: false,
    });

    await sendMessage('Test');
    expect(mockOllamaChat.mock.calls[0]![1]).toBe('first-available');
  });
});
