import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { useSettings } from './useSettings';

// Mock storage
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn(), loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation((_id, updater) => Promise.resolve(updater(null))),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    loadSettings: vi.fn().mockResolvedValue({}),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    updateSettings: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getCurrentType: vi.fn().mockReturnValue('local'),
    notify: vi.fn(),
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
  const { settings, __testOnly: { __testOnlySetSettings } } = useSettings();
  const { sendMessage, currentChat, createNewChat, openChat, updateChatSettings } = useChat();

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default Global Settings
    __testOnlySetSettings({
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
    });

    mockOpenAIModels.mockResolvedValue(['global-gpt', 'profile-gpt', 'chat-gpt']);
    mockOllamaModels.mockResolvedValue(['llama3']);

    mockOpenAIChat.mockImplementation(async (params: { onChunk: (c: string) => void }) => params.onChunk('OpenAI Resp'));
    mockOllamaChat.mockImplementation(async (params: { onChunk: (c: string) => void }) => params.onChunk('Ollama Resp'));

    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    await openChat(chat!.id);
  });

  describe('System Prompt Resolution', () => {
    it('uses Global System Prompt when nothing else is set', async () => {
      await sendMessage('Hi');
      const params = mockOpenAIChat.mock.calls[0]![0];
      const messages = params.messages;
      expect(messages[0]).toEqual({ role: 'system', content: 'Global Default Prompt' });
    });

    it('ignores Profile System Prompt at runtime (Resolution is Chat > Global)', async () => {
      __testOnlySetSettings({
        ...JSON.parse(JSON.stringify(settings.value)),
        providerProfiles: [{
          id: 'p1',
          name: 'Profile 1',
          endpointType: 'openai',
          endpointUrl: 'http://global-openai',
          systemPrompt: 'Profile Prompt',
        }],
      });

      await sendMessage('Hi');
      const params = mockOpenAIChat.mock.calls[0]![0];
      const messages = params.messages;
      // Should find Global Default Prompt, NOT Profile Prompt
      expect(messages[0]).toEqual({ role: 'system', content: 'Global Default Prompt' });
    });

    it('overrides with Chat System Prompt when behavior is override', async () => {
      await updateChatSettings(currentChat.value!.id, { systemPrompt: { content: 'Chat Custom Prompt', behavior: 'override' } });

      await sendMessage('Hi');
      const params = mockOpenAIChat.mock.calls[0]![0];
      const messages = params.messages;
      expect(messages).toHaveLength(2); // System + User
      expect(messages[0]).toEqual({ role: 'system', content: 'Chat Custom Prompt' });
    });

    it('appends Chat System Prompt to Global Prompt, ignoring Profile at runtime', async () => {
      __testOnlySetSettings({
        ...JSON.parse(JSON.stringify(settings.value)),
        providerProfiles: [{
          id: 'p1',
          name: 'Profile 1',
          endpointType: 'openai',
          endpointUrl: 'http://global-openai',
          systemPrompt: 'Profile Prompt',
        } as any],
      });
      await updateChatSettings(currentChat.value!.id, { systemPrompt: { content: 'Chat Extra Prompt', behavior: 'append' } });

      await sendMessage('Hi');
      const params = mockOpenAIChat.mock.calls[0]![0];
      const messages = params.messages;
      // Should find Global Default Prompt + Chat Extra Prompt as separate messages
      expect(messages[0]).toEqual({ role: 'system', content: 'Global Default Prompt' });
      expect(messages[1]).toEqual({ role: 'system', content: 'Chat Extra Prompt' });
    });
  });

  describe('LM Parameters Resolution (Deep Merge)', () => {
    it('merges Chat > Global parameters correctly, ignoring Profile at runtime', async () => {
      __testOnlySetSettings({
        ...JSON.parse(JSON.stringify(settings.value)),
        lmParameters: {
          temperature: 0.1,
          topP: 0.9,
          maxCompletionTokens: 100, // Will be overridden by chat
        },
        // Profile should be ignored at runtime
        providerProfiles: [{
          id: 'p1',
          name: 'P1',
          endpointType: 'openai',
          endpointUrl: 'http://global-openai',
          lmParameters: {
            temperature: 0.5,
            presencePenalty: 1.0,
          },
        } as any],
      });

      await updateChatSettings(currentChat.value!.id, {
        lmParameters: {
          maxCompletionTokens: 500,
          frequencyPenalty: 0.5,
        }
      });

      await sendMessage('Hi');
      const callParams = mockOpenAIChat.mock.calls[0]![0];
      const params = callParams.parameters;

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
      await updateChatSettings(currentChat.value!.id, { lmParameters: { stop: ['\n', 'User:'] } });
      await sendMessage('Hi');
      const callParams = mockOpenAIChat.mock.calls[0]![0];
      const params = callParams.parameters;
      expect(params.stop).toEqual(['\n', 'User:']);
    });
  });
});
