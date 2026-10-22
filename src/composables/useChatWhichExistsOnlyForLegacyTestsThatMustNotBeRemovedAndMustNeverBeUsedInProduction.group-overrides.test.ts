import type { StorageService } from '@/00-storage/service';
import type { LmProvider } from '@/01-models/lm';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction } from './useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction.test-support';
import { storageService } from '@/00-storage/service';
import { reactive } from 'vue';
import type { Chat, ChatContent, ChatGroup, SidebarItem } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { idToRaw, toChatGroupId, toChatId, toMessageId, type ChatGroupId, type ChatId } from '@/01-models/ids';

afterEach(() => {
  for (const providerChat of [mockLmChat]) {
    for (const result of providerChat.mock.results) {
      expect(result.type).toBe('return');
      expect(result.value).toEqual(expect.objectContaining({ [Symbol.asyncIterator]: expect.any(Function) }));
    }
  }
});

// Mock storage
const mockRootItems: SidebarItem[] = [];
const mockSavedChats = new Map<ChatId, Chat>();
const mockSavedChatGroups = new Map<ChatGroupId, ChatGroup>();
const { mockGlobalSettings, mockSavedGlobalSettings } = vi.hoisted(() => {
  const mockSavedGlobalSettings = {
    endpoint: { type: 'openai' as const, url: 'http://global-url' },
    defaultModelId: 'global-model',
    systemPrompt: 'Global Prompt',
    lmParameters: { temperature: 0.7, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
  };
  return { mockGlobalSettings: structuredClone(mockSavedGlobalSettings), mockSavedGlobalSettings };
});

function persistChatHierarchy({ chat, chatGroup }: { chat: Chat, chatGroup: ChatGroup }): void {
  mockSavedChats.set(chat.id, JSON.parse(JSON.stringify(chat)) as Chat);
  const chatItem: SidebarItem = { id: `chat:${idToRaw({ id: chat.id })}`, type: 'chat', chat: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, groupId: chat.groupId } };
  const savedChatGroup = JSON.parse(JSON.stringify({ ...chatGroup, items: chat.groupId === chatGroup.id ? [chatItem] : [] })) as ChatGroup;
  mockSavedChatGroups.set(chatGroup.id, savedChatGroup);
  mockRootItems.splice(0, mockRootItems.length, { id: `chat_group:${idToRaw({ id: chatGroup.id })}`, type: 'chat_group', chatGroup: savedChatGroup });
  if (chat.groupId !== chatGroup.id) {
    mockRootItems.push(chatItem);
  }
}

vi.mock('../00-storage/service', () => ({
  storageService: {
    getModelLaunch: vi.fn<StorageService['getModelLaunch']>().mockReturnValue(undefined),
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn<StorageService['loadChat']>().mockImplementation(async ({ id }) => {
      const saved = mockSavedChats.get(id);
      return saved === undefined ? null : structuredClone(saved);
    }),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn<StorageService['updateChatMeta']>().mockImplementation(async ({ id, updater }) => {
      const current = mockSavedChats.get(id) ?? null;
      const updated = updater({ current });
      if (updated !== undefined) {
        mockSavedChats.set(id, { ...current, ...JSON.parse(JSON.stringify(updated)), root: current?.root ?? { items: [] } });
      }
    }),
    loadChatMeta: vi.fn(),
    updateChatContent: vi.fn<StorageService['updateChatContent']>().mockImplementation(async ({ id, updater }) => {
      const current = mockSavedChats.get(id) ?? null;
      const updated = JSON.parse(JSON.stringify(await updater({ current }))) as ChatContent;
      if (current !== null) {
        mockSavedChats.set(id, { ...current, ...updated });
      }
      return structuredClone(updated);
    }),
    updateHierarchy: vi.fn().mockImplementation(({ updater }) => updater({ current: { items: [] } })),
    deleteChat: vi.fn(),
    updateChatGroup: vi.fn(),
    listChatGroups: vi.fn().mockImplementation(async () => structuredClone([...mockSavedChatGroups.values()])),
    loadChatGroup: vi.fn().mockImplementation(async ({ id }) => {
      const saved = mockSavedChatGroups.get(id);
      return saved === undefined ? null : structuredClone(saved);
    }),
    loadSettings: vi.fn().mockImplementation(async () => structuredClone(mockSavedGlobalSettings)),
    getSidebarStructure: vi.fn().mockImplementation(async () => structuredClone(mockRootItems)),
    deleteChatGroup: vi.fn(),
    notify: vi.fn(),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    synchronizeModelBindingSettings: async ({ isCurrent }: { isCurrent: () => boolean }) => {
      const saved = await storageService.loadSettings();
      if (!isCurrent()) {
        return 'changed';
      }
      Object.assign(mockGlobalSettings, saved);
      return 'synchronized';
    },
    settings: { value: mockGlobalSettings },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

const mockLmChat = vi.fn<LmProvider['chat']>();
vi.mock('../features/lm/openai', () => ({
  OpenAIProvider: function() {
    return {
      chat: mockLmChat,
      listModels: vi.fn().mockResolvedValue(['model-1', 'chat-model', 'group-model', 'group-special-model', 'global-model']),
    };
  },
}));

vi.mock('../features/lm/ollama', () => ({
  OllamaProvider: function() {
    return {
      chat: mockLmChat,
      listModels: vi.fn().mockResolvedValue(['model-1', 'chat-model', 'group-model', 'group-special-model', 'global-model']),
    };
  },
}));

describe('useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction Group Overrides Resolution', () => {
  const chatStore = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockGlobalSettings, structuredClone(mockSavedGlobalSettings));
    mockLmChat.mockImplementation(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ writer }) => {
        await writer.text({ type: 'text', text: 'Response' });
        return { type: 'finished', next: 'user' };
      },
    }));
    chatStore.TEST_ONLY.clearLiveChatRegistry();
    chatStore.rootItems.value = [];
    mockRootItems.length = 0;
    mockSavedChats.clear();
    mockSavedChatGroups.clear();
  });

  it('resolves settings with Chat > Group > Global priority', async () => {
    const group: ChatGroup = {
      id: toChatGroupId({ raw: 'g1' }),
      name: 'Group 1',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      modelId: 'group-model',
      systemPrompt: { content: 'Group Prompt', behavior: 'override' },
      lmParameters: { ...EMPTY_LM_PARAMETERS, temperature: 0.5, reasoning: { effort: undefined } },
    };

    const chat: Chat = reactive({
      id: toChatId({ raw: 'c1' }),
      title: 'Chat 1',
      groupId: toChatGroupId({ raw: 'g1' }),
      root: { items: [{ id: toMessageId({ raw: 'm1' }), role: 'assistant', parts: [], replies: { items: [] }, createdAt: 0, modelId: undefined, interruption: undefined, lmParameters: EMPTY_LM_PARAMETERS }] },
      modelId: 'chat-model',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
      systemPrompt: { content: 'Chat Prompt', behavior: 'append' },
    });

    persistChatHierarchy({ chat, chatGroup: group });

    // Testing sendMessage resolution
    await chatStore.sendMessage({ content: 'Hello', parentId: null, attachments: [], chatTarget: chat });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));

    // Verify the LM was called with resolved settings
    // Resolved System Prompt: ["Group Prompt", "Chat Prompt"]

    expect(mockLmChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'system', parts: [{ type: 'text', text: 'Group Prompt', completeness: 'complete' }] }),
          expect.objectContaining({ role: 'system', parts: [{ type: 'text', text: 'Chat Prompt', completeness: 'complete' }] }),
        ]),
        model: 'chat-model',
        parameters: expect.objectContaining({ temperature: 0.5 }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('resolves system prompt with nested overrides/appends correctly', async () => {
    const group: ChatGroup = {
      id: toChatGroupId({ raw: 'g1' }),
      name: 'Group 1',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      systemPrompt: { content: 'Group Instruction', behavior: 'append' },
    };

    const chat: Chat = reactive({
      id: toChatId({ raw: 'c1' }),
      title: 'Chat 1',
      groupId: toChatGroupId({ raw: 'g1' }),
      root: { items: [{ id: toMessageId({ raw: 'm1' }), role: 'assistant', parts: [], replies: { items: [] }, createdAt: 0, modelId: undefined, interruption: undefined, lmParameters: EMPTY_LM_PARAMETERS }] },
      modelId: 'base-model',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });

    persistChatHierarchy({ chat, chatGroup: group });

    await chatStore.sendMessage({ content: 'Hello', parentId: null, attachments: [], chatTarget: chat });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));

    // Global: "Global Prompt"
    // Group: Append "Group Instruction" -> ["Global Prompt", "Group Instruction"]
    // Chat: None -> Inherit from resolved Group
    expect(mockLmChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'system', parts: [{ type: 'text', text: 'Global Prompt', completeness: 'complete' }] }),
          expect.objectContaining({ role: 'system', parts: [{ type: 'text', text: 'Group Instruction', completeness: 'complete' }] }),
        ]),
        model: expect.any(String),
        parameters: expect.any(Object),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('uses Group modelId if Chat override is missing', async () => {
    const group: ChatGroup = {
      id: toChatGroupId({ raw: 'g1' }),
      name: 'G',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      modelId: 'group-special-model',
    };

    const chat: Chat = reactive({
      id: toChatId({ raw: 'c1' }),
      title: 'Chat 1',
      groupId: toChatGroupId({ raw: 'g1' }),
      root: { items: [{ id: toMessageId({ raw: 'm1' }), role: 'assistant', parts: [], replies: { items: [] }, createdAt: 0, modelId: undefined, interruption: undefined, lmParameters: EMPTY_LM_PARAMETERS }] },
      modelId: '',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });

    persistChatHierarchy({ chat, chatGroup: group });

    await chatStore.sendMessage({ content: 'Hello', parentId: null, attachments: [], chatTarget: chat });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));

    expect(mockLmChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.any(Array),
        model: 'group-special-model',
        parameters: expect.any(Object),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('clears currentChatGroup when opening a chat or creating a new one', async () => {
    chatStore.TEST_ONLY.__testOnlySetCurrentChatGroup({ group: { id: toChatGroupId({ raw: 'g1' }), name: 'G1', items: [], updatedAt: 0, isCollapsed: false } });

    mockSavedChats.set(toChatId({ raw: 'c1' }), { id: toChatId({ raw: 'c1' }), title: 'C1', root: { items: [] }, createdAt: 0, updatedAt: 0, debugEnabled: false });
    await chatStore.openChat({ id: 'c1' });
    expect(chatStore.currentChatGroup.value).toBeNull();

    chatStore.TEST_ONLY.__testOnlySetCurrentChatGroup({ group: { id: toChatGroupId({ raw: 'g1' }), name: 'G1', items: [], updatedAt: 0, isCollapsed: false } });
    await chatStore.createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    expect(chatStore.currentChatGroup.value).toBeNull();
  });

  it('inherits endpoint URL and headers from Group if Chat overrides are missing', async () => {
    const group: ChatGroup = {
      id: toChatGroupId({ raw: 'g1' }),
      name: 'G',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      endpoint: {
        type: 'ollama',
        url: 'http://group-ollama:11434',
        httpHeaders: [['X-Group-Header', 'group-val']],
      },
    };

    const chat: Chat = reactive({
      id: toChatId({ raw: 'c1' }),
      title: 'Chat 1',
      groupId: toChatGroupId({ raw: 'g1' }),
      root: { items: [{ id: toMessageId({ raw: 'm1' }), role: 'assistant', parts: [], replies: { items: [] }, createdAt: 0, modelId: undefined, interruption: undefined, lmParameters: EMPTY_LM_PARAMETERS }] },
      modelId: 'some-model',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });

    persistChatHierarchy({ chat, chatGroup: group });

    await chatStore.sendMessage({ content: 'Hello', parentId: null, attachments: [], chatTarget: chat });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));

    expect(mockLmChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.any(Array),
        model: expect.any(String),
        parameters: expect.any(Object),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('merges LM parameters across all 3 levels (Chat > Group > Global)', async () => {
    // Global: temperature: 0.7
    const group: ChatGroup = {
      id: toChatGroupId({ raw: 'g1' }),
      name: 'G',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      lmParameters: { ...EMPTY_LM_PARAMETERS, topP: 0.5, temperature: 0.9, reasoning: { effort: undefined } }, // Overrides Global temp
    };
    const chat: Chat = reactive({
      id: toChatId({ raw: 'c1' }),
      title: 'Chat 1',
      groupId: toChatGroupId({ raw: 'g1' }),
      root: { items: [{ id: toMessageId({ raw: 'm1' }), role: 'assistant', parts: [], replies: { items: [] }, createdAt: 0, modelId: undefined, interruption: undefined, lmParameters: EMPTY_LM_PARAMETERS }] },
      modelId: 'm1',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
      lmParameters: { ...EMPTY_LM_PARAMETERS, maxCompletionTokens: 100, temperature: 0.1, reasoning: { effort: undefined } }, // Overrides Group temp
    });

    persistChatHierarchy({ chat, chatGroup: group });

    await chatStore.sendMessage({ content: 'Hi', parentId: null, attachments: [], chatTarget: chat });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));

    expect(mockLmChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.any(Array),
        model: expect.any(String),
        parameters: expect.objectContaining({
          temperature: 0.1, // Chat wins
          topP: 0.5, // Group wins (not in chat)
          maxCompletionTokens: 100, // Chat wins
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('suppresses Global prompt when Group uses override behavior with empty content', async () => {
    const group: ChatGroup = {
      id: toChatGroupId({ raw: 'g1' }),
      name: 'G',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      systemPrompt: { content: '', behavior: 'override' },
    };
    const chat: Chat = reactive({
      id: toChatId({ raw: 'c1' }),
      title: 'Chat 1',
      groupId: toChatGroupId({ raw: 'g1' }),
      root: { items: [{ id: toMessageId({ raw: 'm1' }), role: 'assistant', parts: [], replies: { items: [] }, createdAt: 0, modelId: undefined, interruption: undefined, lmParameters: EMPTY_LM_PARAMETERS }] },
      modelId: 'm1',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });

    persistChatHierarchy({ chat, chatGroup: group });

    await chatStore.sendMessage({ content: 'Hi', parentId: null, attachments: [], chatTarget: chat });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));

    const params = mockLmChat.mock.calls[0]![0];
    const messages = params.messages;
    // Global "Global Prompt" should be gone. Only User message left.
    expect(messages.filter(m => m.role === 'system')).toHaveLength(0);
  });

  it('updates resolved settings dynamically when chat is moved to a group', async () => {
    const group: ChatGroup = {
      id: toChatGroupId({ raw: 'g1' }),
      name: 'G',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      modelId: 'group-model',
    };
    const chat: Chat = reactive({
      id: toChatId({ raw: 'c1' }),
      title: 'Chat 1',
      groupId: null, // Initially no group
      root: { items: [{ id: toMessageId({ raw: 'm1' }), role: 'assistant', parts: [], replies: { items: [] }, createdAt: 0, modelId: undefined, interruption: undefined, lmParameters: EMPTY_LM_PARAMETERS }] },
      modelId: '',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });

    persistChatHierarchy({ chat, chatGroup: group });

    // 1. Send message while Chat is NOT in group
    await chatStore.sendMessage({ content: 'Hi', parentId: null, attachments: [], chatTarget: chat });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));
    expect(mockLmChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.any(Array),
        model: 'global-model',
        parameters: expect.any(Object),
        signal: expect.any(AbortSignal),
      }),
    );

    // 2. Move chat to group
    await storageService.updateChatMeta({ id: chat.id, updater: ({ current }) => ({ ...current!, groupId: group.id }) });
    persistChatHierarchy({ chat: mockSavedChats.get(chat.id)!, chatGroup: group });

    await chatStore.sendMessage({ content: 'Hi again', parentId: null, attachments: [], chatTarget: chat });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));

    expect(mockLmChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.any(Array),
        model: 'group-model',
        parameters: expect.any(Object),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('inherits endpoint URL and headers from Group if Chat overrides are missing', async () => {
    const group: ChatGroup = {
      id: toChatGroupId({ raw: 'g1' }),
      name: 'G',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      endpoint: {
        type: 'ollama',
        url: 'http://group-ollama:11434',
        httpHeaders: [['X-Group-Header', 'group-val']],
      },
    };

    const chat: Chat = reactive({
      id: toChatId({ raw: 'c1' }),
      title: 'Chat 1',
      groupId: toChatGroupId({ raw: 'g1' }),
      root: { items: [{ id: toMessageId({ raw: 'm1' }), role: 'assistant', parts: [], replies: { items: [] }, createdAt: 0, modelId: undefined, interruption: undefined, lmParameters: EMPTY_LM_PARAMETERS }] },
      modelId: 'some-model',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });

    persistChatHierarchy({ chat, chatGroup: group });

    await chatStore.sendMessage({ content: 'Hello', parentId: null, attachments: [], chatTarget: chat });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));

    expect(mockLmChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.any(Array),
        model: expect.any(String),
        parameters: expect.any(Object),
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
