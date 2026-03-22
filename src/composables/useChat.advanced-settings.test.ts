import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reactive } from 'vue';
import { useChat } from './useChat';
import { useSettings } from './useSettings';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import { storageService } from '@/services/storage';

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
      mounts: [],
      systemPrompt: 'Global Default Prompt',
      lmParameters: {
        ...EMPTY_LM_PARAMETERS,
        temperature: 0.7,
        maxCompletionTokens: 1000,
        reasoning: { effort: undefined },
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
      await sendMessage({ content: 'Hi' });
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

      await sendMessage({ content: 'Hi' });
      const params = mockOpenAIChat.mock.calls[0]![0];
      const messages = params.messages;
      // Should find Global Default Prompt, NOT Profile Prompt
      expect(messages[0]).toEqual({ role: 'system', content: 'Global Default Prompt' });
    });

    it('overrides with Chat System Prompt when behavior is override', async () => {
      await updateChatSettings(currentChat.value!.id, { systemPrompt: { content: 'Chat Custom Prompt', behavior: 'override' } });

      await sendMessage({ content: 'Hi' });
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

      await sendMessage({ content: 'Hi' });
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
          ...EMPTY_LM_PARAMETERS,
          temperature: 0.1,
          topP: 0.9,
          maxCompletionTokens: 100, // Will be overridden by chat
          reasoning: { effort: undefined },
        },
        // Profile should be ignored at runtime
        providerProfiles: [{
          id: 'p1',
          name: 'P1',
          endpointType: 'openai',
          endpointUrl: 'http://global-openai',
          lmParameters: {
            ...EMPTY_LM_PARAMETERS,
            temperature: 0.5,
            presencePenalty: 1.0,
            reasoning: { effort: undefined },
          },
        } as any],
      });

      await updateChatSettings(currentChat.value!.id, {
        lmParameters: {
          ...EMPTY_LM_PARAMETERS,
          maxCompletionTokens: 500,
          frequencyPenalty: 0.5,
          reasoning: { effort: undefined },
        }
      });

      await sendMessage({ content: 'Hi' });
      const callParams = mockOpenAIChat.mock.calls[0]![0];
      const params = callParams.parameters;

      expect(params).toEqual({
        temperature: 0.1,         // From Global (Profile 0.5 ignored)
        topP: 0.9,                // From Global
        maxCompletionTokens: 500, // From Chat
        frequencyPenalty: 0.5,    // From Chat
        reasoning: { effort: undefined },
        // presencePenalty: 1.0 from Profile should be missing
      });
      expect(params.presencePenalty).toBeUndefined();
    });
  });

  describe('Stop Sequences Handling', () => {
    it('passes stop sequences as array', async () => {
      await updateChatSettings(currentChat.value!.id, { lmParameters: { ...EMPTY_LM_PARAMETERS, stop: ['\n', 'User:'], reasoning: { effort: undefined } } });
      await sendMessage({ content: 'Hi' });
      const callParams = mockOpenAIChat.mock.calls[0]![0];
      const params = callParams.parameters;
      expect(params.stop).toEqual(['\n', 'User:']);
    });
  });

  describe('Chat Independence', () => {
    const { __testOnly: { __testOnlySetCurrentChat } } = useChat();

    it('should NOT leak lmParameters from Chat A to Chat B when switching', async () => {
      // 1. Create Chat A and set custom params
      const chatA = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
      await openChat(chatA!.id);

      // Update with reasoning effort
      const chatAObj = {
        ...chatA!,
        lmParameters: {
          ...EMPTY_LM_PARAMETERS,
          temperature: 0.1,
          reasoning: { effort: 'high' as const }
        }
      };
      __testOnlySetCurrentChat(reactive(chatAObj) as any);

      expect(currentChat.value?.lmParameters?.temperature).toBe(0.1);
      expect(currentChat.value?.lmParameters?.reasoning?.effort).toBe('high');

      // 2. Create Chat B
      const chatB = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });

      // Once we open B, it should be clean
      await openChat(chatB!.id);

      // Verify Chat B uses defaults (global settings), not Chat A's values
      expect(currentChat.value?.lmParameters?.temperature).toBeUndefined();
      expect(currentChat.value?.lmParameters?.reasoning?.effort).toBeUndefined();
      expect(currentChat.value?.id).toBe(chatB!.id);
    });
  });
});

// Regression test: Chat Specific Overrides endpoint settings must persist across reload.
// Bug: updateChatSettings spread Chat flat fields (endpointType/endpointUrl/endpointHttpHeaders)
// directly onto ChatMeta, but the storage layer only reads the nested `endpoint` object.
// On reload, the endpoint reverted because the flat fields were never saved correctly.
describe('Chat Specific Overrides - Endpoint Persistence', () => {
  const { __testOnly: { __testOnlySetSettings } } = useSettings();
  const { currentChat, createNewChat, openChat, updateChatSettings } = useChat();

  beforeEach(async () => {
    vi.clearAllMocks();
    __testOnlySetSettings({
      endpointType: 'openai',
      endpointUrl: 'http://global-openai',
      defaultModelId: 'global-gpt',
      autoTitleEnabled: false,
      storageType: 'local',
      providerProfiles: [],
      mounts: [],
      systemPrompt: undefined,
      lmParameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: undefined } },
    });
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    await openChat(chat!.id);
  });

  it('stores endpoint as a nested object so it survives a page reload', async () => {
    // Capture the async updater that updateChatMeta passes to storageService.updateChatMeta.
    // In production, storage calls this updater with the stored ChatMeta and saves the result.
    let capturedStorageUpdater: ((curr: unknown) => Promise<unknown>) | undefined;
    vi.mocked(storageService.updateChatMeta).mockImplementationOnce((_id, updater) => {
      capturedStorageUpdater = updater as typeof capturedStorageUpdater;
      return Promise.resolve(undefined as any);
    });

    // loadChat is called by the inner wrapper to reconstruct the full Chat.
    // Return the live chat so the updater receives a valid object.
    vi.mocked(storageService.loadChat).mockResolvedValueOnce(currentChat.value as any);

    await updateChatSettings(currentChat.value!.id, {
      endpointType: 'openai',
      endpointUrl: 'http://chat-specific-url',
      endpointHttpHeaders: [['Authorization', 'Bearer secret']],
    });

    expect(capturedStorageUpdater).toBeDefined();

    // Simulate storage calling the updater with the existing ChatMeta row.
    const existingMeta = { id: currentChat.value!.id, title: null, createdAt: 0, updatedAt: 0, debugEnabled: false };
    const saved = await capturedStorageUpdater!(existingMeta) as Record<string, unknown>;

    // Endpoint must be saved as a nested object — not as flat fields.
    // If flat fields appear here the storage mapper silently ignores them and the
    // settings revert to the previous value on the next page load.
    expect(saved['endpoint']).toEqual({
      type: 'openai',
      url: 'http://chat-specific-url',
      httpHeaders: [['Authorization', 'Bearer secret']],
    });
    expect(saved['endpointType']).toBeUndefined();
    expect(saved['endpointUrl']).toBeUndefined();
    expect(saved['endpointHttpHeaders']).toBeUndefined();
  });

  it('clears the stored endpoint object when endpointType is unset', async () => {
    let capturedStorageUpdater: ((curr: unknown) => Promise<unknown>) | undefined;
    vi.mocked(storageService.updateChatMeta).mockImplementationOnce((_id, updater) => {
      capturedStorageUpdater = updater as typeof capturedStorageUpdater;
      return Promise.resolve(undefined as any);
    });
    vi.mocked(storageService.loadChat).mockResolvedValueOnce(currentChat.value as any);

    // Omitting endpointType means no chat-specific endpoint override.
    await updateChatSettings(currentChat.value!.id, { modelId: 'custom-model' });

    const existingMeta = { id: currentChat.value!.id, title: null, createdAt: 0, updatedAt: 0, debugEnabled: false };
    const saved = await capturedStorageUpdater!(existingMeta) as Record<string, unknown>;

    expect(saved['endpoint']).toBeUndefined();
    expect(saved['modelId']).toBe('custom-model');
  });
});
