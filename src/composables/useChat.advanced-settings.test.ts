import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { useSettings } from './useSettings';
import { reactive } from 'vue';

// Mock storage
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    saveChatMeta: vi.fn(),
    saveChatContent: vi.fn(),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
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

vi.mock('../services/llm', () => ({
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
}));

describe('useChat Advanced Settings Resolution', () => {
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
      systemPrompt: 'Global Default Prompt',
      lmParameters: {
        temperature: 0.7,
        maxCompletionTokens: 1000,
      },
    };

    mockOpenAIModels.mockResolvedValue(['global-gpt', 'profile-gpt', 'chat-gpt']);
    mockOllamaModels.mockResolvedValue(['llama3']);
    
    mockOpenAIChat.mockImplementation(async (_msg, _model, _url, onChunk) => onChunk('OpenAI Resp'));
    mockOllamaChat.mockImplementation(async (_msg, _model, _url, onChunk) => onChunk('Ollama Resp'));
    
    currentChat.value = reactive({
      id: 'test-chat',
      title: 'Test Chat',
      root: { items: [] },
      modelId: 'global-gpt',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    });
  });

  describe('System Prompt Resolution', () => {
    it('uses Global System Prompt when nothing else is set', async () => {
      await sendMessage('Hi');
      const messages = mockOpenAIChat.mock.calls[0]![0];
      expect(messages[0]).toEqual({ role: 'system', content: 'Global Default Prompt' });
    });

    it('ignores Profile System Prompt at runtime (Resolution is Chat > Global)', async () => {
      settings.value.providerProfiles = [{
        id: 'p1',
        name: 'Profile 1',
        endpointType: 'openai',
        endpointUrl: 'http://global-openai',
        systemPrompt: 'Profile Prompt',
      }];

      await sendMessage('Hi');
      const messages = mockOpenAIChat.mock.calls[0]![0];
      // Should find Global Default Prompt, NOT Profile Prompt
      expect(messages[0]).toEqual({ role: 'system', content: 'Global Default Prompt' });
    });

    it('overrides with Chat System Prompt when behavior is override', async () => {
      currentChat.value!.systemPrompt = { content: 'Chat Custom Prompt', behavior: 'override' };

      await sendMessage('Hi');
      const messages = mockOpenAIChat.mock.calls[0]![0];
      expect(messages).toHaveLength(2); // System + User
      expect(messages[0]).toEqual({ role: 'system', content: 'Chat Custom Prompt' });
    });

    it('appends Chat System Prompt to Global Prompt, ignoring Profile at runtime', async () => {
      settings.value.providerProfiles = [{
        id: 'p1',
        name: 'Profile 1',
        endpointType: 'openai',
        endpointUrl: 'http://global-openai',
        systemPrompt: 'Profile Prompt',
      }];
      currentChat.value!.systemPrompt = { content: 'Chat Extra Prompt', behavior: 'append' };

      await sendMessage('Hi');
      const messages = mockOpenAIChat.mock.calls[0]![0];
      // Should find Global Default Prompt + Chat Extra Prompt as separate messages
      expect(messages[0]).toEqual({ role: 'system', content: 'Global Default Prompt' });
      expect(messages[1]).toEqual({ role: 'system', content: 'Chat Extra Prompt' });
    });
  });

  describe('LM Parameters Resolution (Deep Merge)', () => {
    it('merges Chat > Global parameters correctly, ignoring Profile at runtime', async () => {
      settings.value.lmParameters = {
        temperature: 0.1, 
        topP: 0.9,        
        maxCompletionTokens: 100, // Will be overridden by chat
      };

      // Profile should be ignored at runtime
      settings.value.providerProfiles = [{
        id: 'p1',
        name: 'P1',
        endpointType: 'openai',
        endpointUrl: 'http://global-openai',
        lmParameters: {
          temperature: 0.5,
          presencePenalty: 1.0,
        },
      }];

      currentChat.value!.lmParameters = {
        maxCompletionTokens: 500,
        frequencyPenalty: 0.5,
      };

      await sendMessage('Hi');
      const params = mockOpenAIChat.mock.calls[0]![4];
      
      expect(params).toEqual({
        temperature: 0.1,         // From Global (Profile 0.5 ignored)
        topP: 0.9,                // From Global
        maxCompletionTokens: 500, // From Chat
        frequencyPenalty: 0.5,    // From Chat
        // presencePenalty: 1.0 from Profile should be missing
      });
      expect(params.presencePenalty).toBeUndefined();
    });
  });

  describe('Stop Sequences Handling', () => {
    it('passes stop sequences as array', async () => {
      currentChat.value!.lmParameters = { stop: ['\n', 'User:'] };
      await sendMessage('Hi');
      const params = mockOpenAIChat.mock.calls[0]![4];
      expect(params.stop).toEqual(['\n', 'User:']);
    });
  });
});
