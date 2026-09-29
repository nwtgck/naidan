import type { LmProvider } from '@/01-models/lm';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction } from './useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction';
import { useSettings } from './useSettings';
import { reactive, nextTick } from 'vue';
import { idToRaw, toChatGroupId, toChatId } from '@/01-models/ids';
import { storageService } from '@/00-storage/service';
import type { ChatMeta } from '@/01-models/types';

afterEach(() => {
  for (const providerChat of [mockOpenAIChat, mockOllamaChat]) {
    for (const result of providerChat.mock.results) {
      expect(result.type).toBe('return');
      expect(result.value).toEqual(expect.objectContaining({ [Symbol.asyncIterator]: expect.any(Function) }));
    }
  }
});

// Mock storage
vi.mock('../00-storage/service', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    saveChat: vi.fn().mockResolvedValue(undefined),
    updateChatMeta: vi.fn(), loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation(({ updater }) => Promise.resolve(updater({ current: null }))),
    updateHierarchy: vi.fn().mockImplementation(({ updater }) => updater({ current: { items: [] } })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    loadChat: vi.fn(),
    loadSettings: vi.fn().mockResolvedValue({}),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    updateSettings: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
    loadChatGroup: vi.fn().mockResolvedValue(null),
    getCurrentType: vi.fn().mockReturnValue('local'),
    notify: vi.fn(),
  },
}));

const mockOpenAIChat = vi.fn<LmProvider['chat']>();
const mockOllamaChat = vi.fn<LmProvider['chat']>();
const mockOpenAIModels = vi.fn();
const mockOllamaModels = vi.fn();

// Proper class mocking for Vitest
vi.mock('../features/lm/openai', () => ({
  OpenAIProvider: vi.fn().mockImplementation(function() {
    return {
      chat: mockOpenAIChat,
      listModels: mockOpenAIModels,
    };
  }),
}));

vi.mock('../features/lm/ollama', () => ({
  OllamaProvider: vi.fn().mockImplementation(function() {
    return {
      chat: mockOllamaChat,
      listModels: mockOllamaModels,
    };
  }),
}));

describe('useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction Settings Resolution Policy', () => {
  const { settings, TEST_ONLY: { __testOnlySetSettings } } = useSettings();
  const chatStore = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();
  const { sendMessage, currentChat, createNewChat, openChat, updateChatModel, updateChatSettings } = chatStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(storageService.getSidebarStructure).mockImplementation(() => Promise.resolve(chatStore.rootItems.value));

    // Default Global Settings
    __testOnlySetSettings({ newSettings: {
      endpoint: { type: 'openai', url: 'http://global-openai' },
      defaultModelId: 'global-gpt',
      titleGeneration: 'disabled',
      storageType: 'local',
      providerProfiles: [],
      mounts: [],
    } });

    mockOpenAIModels.mockResolvedValue(['global-gpt', 'other-gpt', 'pinned-model', 'model-a', 'model-b']);
    mockOllamaModels.mockResolvedValue(['llama-global', 'llama-other']);

    mockOpenAIChat.mockImplementation(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ writer }) => {
        await writer.text({ type: 'text', text: 'OpenAI Resp' });
        return { type: 'finished', next: 'user' };
      },
    }));
    mockOllamaChat.mockImplementation(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ writer }) => {
        await writer.text({ type: 'text', text: 'Ollama Resp' });
        return { type: 'finished', next: 'user' };
      },
    }));

    chatStore.TEST_ONLY.__testOnlySetCurrentChat({ chat: null });
  });

  it('Scenario: Global setting change should be reflected in existing chat for subsequent messages', async () => {
    // 1. Setup with Setting A
    __testOnlySetSettings({ newSettings: {
      ...JSON.parse(JSON.stringify(settings.value)),
      endpoint: { type: 'openai', url: 'http://endpoint-a' },
      defaultModelId: 'global-gpt',
    } });

    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const id = chat!.id;
    await openChat({ id: idToRaw({ id }) });

    // Send first message using Global A
    await sendMessage({ content: 'Message 1' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: id }));
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'global-gpt', signal: expect.any(AbortSignal) }));

    // 2. Change to Setting B
    __testOnlySetSettings({ newSettings: {
      ...JSON.parse(JSON.stringify(settings.value)),
      endpoint: { type: 'openai', url: 'http://endpoint-b' },
      defaultModelId: 'model-b',
    } });

    // Send second message in SAME chat - should now use Global B
    await sendMessage({ content: 'Message 2' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: id }));
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'model-b', signal: expect.any(AbortSignal) }));

    // 3. Verify that the chat object itself didn't "lock in" model-b
    expect(currentChat.value!.modelId).toBeUndefined();
  });

  it('Policy: Prioritize chat-level modelId (Pinning)', async () => {
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const id = chat!.id;
    await openChat({ id: idToRaw({ id }) });
    await updateChatModel({ id: idToRaw({ id }), modelId: 'pinned-model' });

    await sendMessage({ content: 'M1' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: id }));
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'pinned-model', signal: expect.any(AbortSignal) }));

    // Change global model - should NOT affect pinned chat
    __testOnlySetSettings({ newSettings: { ...JSON.parse(JSON.stringify(settings.value)), defaultModelId: 'new-global-gpt' } });
    await sendMessage({ content: 'M2' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: id }));
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'pinned-model', signal: expect.any(AbortSignal) }));
  });

  it('Policy: Respect chat-level endpoint settings while following global model if not pinned', async () => {
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const id = chat!.id;
    await openChat({ id: idToRaw({ id }) });
    await updateChatSettings({ id: idToRaw({ id }), updates: {
      endpoint: { type: 'ollama', url: 'http://pinned-ollama' },
    } });

    // Global is OpenAI, but chat endpoint is Ollama. Model should be llama-global because Ollama list results in llama-global
    await sendMessage({ content: 'M1' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: id }));
    expect(mockOllamaChat).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'llama-global', signal: expect.any(AbortSignal) }));

    // Change global model to something available in Ollama
    __testOnlySetSettings({ newSettings: { ...JSON.parse(JSON.stringify(settings.value)), defaultModelId: 'llama-other' } });
    await sendMessage({ content: 'M2' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: id }));
    expect(mockOllamaChat).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'llama-other', signal: expect.any(AbortSignal) }));
  });

  it('Policy: Dynamic resolution when preferred model is unavailable', async () => {
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const id = chat!.id;
    await openChat({ id: idToRaw({ id }) });

    __testOnlySetSettings({ newSettings: { ...JSON.parse(JSON.stringify(settings.value)), defaultModelId: 'non-existent' } });
    mockOpenAIModels.mockResolvedValue(['first-available', 'second']);

    await sendMessage({ content: 'M1' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: id }));
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'first-available', signal: expect.any(AbortSignal) }));
  });

  it('Policy: Resolve an endpoint atomically at Chat or Global scope', async () => {
    // 1. Global only
    __testOnlySetSettings({ newSettings: {
      ...JSON.parse(JSON.stringify(settings.value)),
      endpoint: {
        type: 'openai',
        url: 'http://global-openai',
        httpHeaders: [['X-Global', '1']],
      },
    } });
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const id = chat!.id;
    await openChat({ id: idToRaw({ id }) });

    await sendMessage({ content: 'G' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: id }));
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.objectContaining({ model: expect.any(String), signal: expect.any(AbortSignal) }));

    // 2. Chat Override
    await updateChatSettings({
      id: idToRaw({ id }),
      updates: {
        endpoint: {
          type: 'openai',
          url: 'http://chat-openai',
          httpHeaders: [['X-Chat', '3']],
        },
      },
    });
    await sendMessage({ content: 'C' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: id }));
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.objectContaining({ model: expect.any(String), signal: expect.any(AbortSignal) }));
  });

  it('applies_an_atomic_endpoint_override_to_a_non_live_group_chat', async () => {
    const chatId = toChatId({ raw: 'non-live-group-chat' });
    const groupId = toChatGroupId({ raw: 'group-endpoint' });
    const storedMeta: ChatMeta = {
      id: chatId,
      title: 'Grouped chat',
      createdAt: 1,
      updatedAt: 2,
      debugEnabled: false,
    };
    chatStore.rootItems.value = [{
      id: 'chat_group:group-endpoint',
      type: 'chat_group',
      chatGroup: reactive({
        id: groupId,
        name: 'Endpoint group',
        isCollapsed: false,
        updatedAt: 3,
        endpoint: {
          type: 'ollama' as const,
          url: 'http://group-ollama:11434',
          httpHeaders: [['X-Group', '1']] as [string, string][],
        },
        items: [{
          id: 'chat:non-live-group-chat',
          type: 'chat',
          chat: {
            id: chatId,
            title: 'Grouped chat',
            updatedAt: 2,
            groupId,
          },
        }],
      }),
    }];

    vi.mocked(storageService.loadChatMeta).mockResolvedValue(storedMeta);
    let persisted: ChatMeta = storedMeta;
    vi.mocked(storageService.updateChatMeta).mockImplementation(async ({ updater }) => {
      persisted = await updater({ current: persisted });
    });

    await updateChatSettings({
      id: idToRaw({ id: chatId }),
      updates: {
        endpoint: {
          type: 'ollama',
          url: 'http://chat-ollama:11434',
          httpHeaders: [['X-Group', '1']],
        },
      },
    });

    expect(persisted.endpoint).toEqual({
      type: 'ollama',
      url: 'http://chat-ollama:11434',
      httpHeaders: [['X-Group', '1']],
    });
  });

  it('Policy: Hierarchy Resolution (Chat > Group > Global) in resolvedSettings metadata', async () => {
    const { rootItems, resolvedSettings, createNewChat, openChat, updateChatModel, updateChatGroupOverride } = chatStore;

    // 1. Initial State: Global Default
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const id = chat!.id;
    await openChat({ id: idToRaw({ id }) });

    expect(resolvedSettings.value?.modelId).toBe('global-gpt');
    expect(resolvedSettings.value?.sources.modelId).toBe('global');

    // 2. Add Group Default
    const group = reactive({
      id: toChatGroupId({ raw: 'g1' }), name: 'Group 1', items: [], updatedAt: Date.now(), isCollapsed: false,
      modelId: 'group-model',
    }) as any;
    rootItems.value = [{ id: 'chat_group:g1', type: 'chat_group', chatGroup: group }];
    await updateChatGroupOverride({ id: idToRaw({ id }), groupId: 'g1' });
    await nextTick();

    expect(resolvedSettings.value?.modelId).toBe('group-model');
    expect(resolvedSettings.value?.sources.modelId).toBe('chat_group');

    // 3. Add Chat Override
    await updateChatModel({ id: idToRaw({ id }), modelId: 'chat-model' });
    await nextTick();
    expect(resolvedSettings.value?.modelId).toBe('chat-model');
    expect(resolvedSettings.value?.sources.modelId).toBe('chat');

    // 4. Remove Chat Override -> Should go back to Group
    await updateChatModel({ id: idToRaw({ id }), modelId: undefined as any });
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
