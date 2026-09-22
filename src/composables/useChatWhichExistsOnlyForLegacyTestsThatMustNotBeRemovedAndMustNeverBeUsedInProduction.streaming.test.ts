import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction } from './useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction';
import type { ChatId } from '@/01-models/ids';
import type { LmProvider } from '@/01-models/lm';
import { getMessageText } from '@/01-models/message-text';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { ensureAllStringsForTest } from '@/strings/test-utils';

// --- Mocks ---
vi.mock('../00-storage/service', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn(), loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation(({ updater }) => Promise.resolve(updater({ current: { root: { items: [] }, currentLeafId: undefined } }))),
    updateHierarchy: vi.fn().mockImplementation(({ updater }) => updater({ current: { items: [] } })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    deleteChat: vi.fn(),
    updateChatGroup: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    loadChatGroup: vi.fn().mockResolvedValue(null),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    notify: vi.fn(),
  },
}));

const mockSettings = {
  value: {
    endpoint: {
      type: 'openai',
      url: 'http://localhost',
    },
    storageType: 'local',
    mounts: [],
    titleGeneration: 'disabled',
    defaultModelId: 'gpt-4',
    lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
    providerProfiles: [],
  },
};

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: mockSettings,
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

const mockLmChat = vi.fn<LmProvider['chat']>();
vi.mock('../features/lm/openai', () => ({
  OpenAIProvider: function() {
    return {
      chat: mockLmChat,
      listModels: vi.fn().mockResolvedValue(['gpt-4']),
    };
  },
}));

vi.mock('../features/lm/ollama', () => ({
  OllamaProvider: function() {
    return {
      chat: mockLmChat,
      listModels: vi.fn().mockResolvedValue(['gpt-4']),
    };
  },
}));

describe('useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction Streaming State Logic', () => {
  const chatStore = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();
  const { currentChat, TEST_ONLY, streaming, sendMessage, createNewChat, abortChat } = chatStore;
  const { activeGenerations, __testOnlySetCurrentChat } = TEST_ONLY;

  const waitForRegistry = async ({ id }: { id: ChatId }) => {
    await vi.waitUntil(() => activeGenerations.has(id), { timeout: 2000 });
  };

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    mockLmChat.mockReset();
    TEST_ONLY.clearLiveChatRegistry();
    __testOnlySetCurrentChat({ chat: null });
  });

  it('should correctly set streaming state when generation starts and ends', async () => {
    await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chat = currentChat.value!;
    const accepted = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    mockLmChat.mockImplementationOnce(({ signal }) => createChatGenerationStream({ signal, run: async ({ writer }) => {
      await writer.text({ type: 'text', text: 'Start' });
      accepted.resolve();
      await finish.promise;
      await writer.text({ type: 'text', text: 'End' });
      return { type: 'finished', next: 'user' };
    } }));
    const sendPromise = sendMessage({ content: 'Hello' });
    try {
      await accepted.promise;
      await waitForRegistry({ id: chat.id });
      expect(streaming.value).toBe(true);
      expect(activeGenerations.has(chat.id)).toBe(true);
      await vi.waitUntil(() => getMessageText({ message: chat.root.items[0]!.replies.items[0]! }) === 'Start');
    } finally {
      finish.resolve();
      await sendPromise;
      await vi.waitUntil(() => !streaming.value, { timeout: 5000 });
    }
    expect(activeGenerations.has(chat.id)).toBe(false);
    const assistant = chat.root.items[0]!.replies.items[0]!;
    expect(assistant.parts).toMatchObject([{ type: 'text', text: 'StartEnd', completeness: 'complete' }]);
  });

  it('should clear streaming state when aborted, after the producer settles', async () => {
    await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chat = currentChat.value!;
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const sawAbort = Promise.withResolvers<void>();
    mockLmChat.mockImplementationOnce(({ signal }) => createChatGenerationStream({ signal, run: async ({ writer, signal }) => {
      await writer.text({ type: 'text', text: 'Unfinished' });
      signal.addEventListener('abort', () => sawAbort.resolve(), { once: true });
      started.resolve();
      // A stop request is not permission to release an uncooperative producer early.
      await finish.promise;
      return { type: 'interrupted', reason: 'aborted' };
    } }));
    const sendPromise = sendMessage({ content: 'Hello' });
    try {
      await started.promise;
      await waitForRegistry({ id: chat.id });
      abortChat({ chatId: undefined });
      await sawAbort.promise;
      expect(streaming.value).toBe(true);
      expect(activeGenerations.has(chat.id)).toBe(true);
    } finally {
      finish.resolve();
      await sendPromise;
      await vi.waitUntil(() => !streaming.value, { timeout: 5000 });
    }
    expect(activeGenerations.has(chat.id)).toBe(false);
    const assistant = chat.root.items[0]!.replies.items[0]!;
    expect(assistant.parts).toMatchObject([{ type: 'text', text: 'Unfinished', completeness: 'partial' }]);
    expect(assistant.role === 'assistant' && assistant.interruption).toEqual({ type: 'cancelled' });
  });
});
