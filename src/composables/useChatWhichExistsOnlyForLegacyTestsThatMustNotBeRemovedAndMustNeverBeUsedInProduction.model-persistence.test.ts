import type { LmProvider } from '@/01-models/lm';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { getMessageText } from '@/01-models/message-text';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction } from './useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction';
import { storageService } from '@/00-storage/service';
import { reactive, triggerRef } from 'vue';
import type { Chat, SidebarItem } from '@/01-models/types';
import { idToRaw, toChatId } from '@/01-models/ids';

// Mock storage service state
const mockRootItems: SidebarItem[] = [];

vi.mock('../00-storage/service', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    updateChatMeta: vi.fn(), loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation(({ updater }) => Promise.resolve(updater({ current: { root: { items: [] }, currentLeafId: undefined } }))),
    loadChatContent: vi.fn().mockResolvedValue(null),
    updateHierarchy: vi.fn().mockImplementation(({ updater }) => updater({ current: { items: [] } })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    deleteChat: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    loadChatGroup: vi.fn().mockResolvedValue(null),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    notify: vi.fn(),
  },
}));

// Mock settings
const mockSettings = {
  endpoint: {
    type: 'openai' as const,
    url: 'http://localhost',
  },
  storageType: 'local' as const,
  mounts: [],
  titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
  defaultModelId: 'gpt-3.5-turbo',
};

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: mockSettings },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

// Mock LM Provider
const mockChat = vi.fn<LmProvider['chat']>().mockImplementation(({ model, signal }) => createChatGenerationStream({
  signal,
  run: async ({ writer }) => {
    await writer.text({ type: 'text', text: 'Response from ' + model });
    return { type: 'finished', next: 'user' };
  },
}));

vi.mock('../features/lm/openai', () => {
  class MockOpenAI {
    constructor() {}
    chat = mockChat;
    listModels = vi.fn().mockResolvedValue(['gpt-3.5-turbo', 'gpt-4']);
  }
  return {
    OpenAIProvider: MockOpenAI,
  };
});

vi.mock('../features/lm/ollama', () => ({
  OllamaProvider: vi.fn(),
}));

describe('useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction Model ID Persistence & Resolution', () => {
  const chatStore = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();
  const { sendMessage, currentChat, activeMessages, TEST_ONLY, updateChatModel } = chatStore;
  const { __testOnlySetCurrentChat } = TEST_ONLY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRootItems.length = 0;

    vi.mocked(storageService.loadChat).mockImplementation(({ id }: any) => {
      if (id === 'c1') return Promise.resolve({ id: toChatId({ raw: 'c1' }), title: 'C1', modelId: 'm1', root: { items: [] } } as any);
      return Promise.resolve(null);
    });
  });

  it('should persist different modelIds for each assistant message when model is changed', async () => {
    // 1. Setup a chat with initial model
    const chatObj: Chat = reactive({
      id: toChatId({ raw: 'model-test-chat' }),
      title: 'Model Test',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat({ chat: chatObj });

    // 2. Send first message with default model
    await sendMessage({ content: 'Hello with 3.5' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chatObj.id }));
    triggerRef(currentChat);

    expect(activeMessages.value).toHaveLength(2);
    expect(activeMessages.value[1]?.role).toBe('assistant');
    expect(activeMessages.value[1]?.modelId).toBe('gpt-3.5-turbo');
    expect(getMessageText({ message: activeMessages.value[1]! })).toContain('Response from gpt-3.5-turbo');

    // 3. Change the model for the chat
    await updateChatModel({ id: idToRaw({ id: chatObj.id }), modelId: 'gpt-4' });

    // 4. Send second message with new model
    await sendMessage({ content: 'Hello with 4' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chatObj.id }));
    triggerRef(currentChat);

    expect(activeMessages.value).toHaveLength(4);

    // Check first assistant message still has old model
    expect(activeMessages.value[1]?.modelId).toBe('gpt-3.5-turbo');

    // Check second assistant message has new model
    expect(activeMessages.value[3]?.role).toBe('assistant');
    expect(activeMessages.value[3]?.modelId).toBe('gpt-4');
    expect(getMessageText({ message: activeMessages.value[3]! })).toContain('Response from gpt-4');

    // 5. Verify storage was called with correct modelIds in the tree
    expect(storageService.updateChatContent).toHaveBeenCalled();
    const lastCall = vi.mocked(storageService.updateChatContent).mock.calls[vi.mocked(storageService.updateChatContent).mock.calls.length - 1];
    const updater = lastCall![0].updater;
    const lastSavedContent = await (updater as any)({ current: null });

    // Path: root -> user1 -> assistant1 (gpt-3.5) -> user2 -> assistant2 (gpt-4)
    const assistant1 = lastSavedContent.root.items[0]?.replies.items[0];
    const assistant2 = assistant1?.replies.items[0]?.replies.items[0];

    expect(assistant1?.modelId).toBe('gpt-3.5-turbo');
    expect(assistant2?.modelId).toBe('gpt-4');
  });
});
