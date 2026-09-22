import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, reactive } from 'vue';
import type { LmProvider } from '@/01-models/lm';
import type { Chat } from '@/01-models/types';
import { idToRaw, toChatId } from '@/01-models/ids';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { getMessageText } from '@/01-models/message-text';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction } from './useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction';

// Mock useSettings
vi.mock('./useSettings', () => ({
  useSettings: vi.fn().mockReturnValue({
    settings: ref({
      endpoint: {
        type: 'openai',
        url: 'http://localhost:11434/v1',
      },
      defaultModelId: 'gpt-4',
      titleGeneration: 'disabled',
    }),
    setHeavyContentAlertDismissed: vi.fn(),
    setOnboardingDraft: vi.fn(),
    setIsOnboardingDismissed: vi.fn(),
  }),
}));

// Mock LM providers
const mockLmChat = vi.fn<LmProvider['chat']>();
vi.mock('../features/lm/openai', () => ({
  OpenAIProvider: class {
    chat = mockLmChat;
    listModels = vi.fn().mockResolvedValue(['gpt-4']);
  },
}));

vi.mock('../features/lm/ollama', () => ({
  OllamaProvider: class {
    chat = vi.fn();
    listModels = vi.fn().mockResolvedValue([]);
  },
}));

// Mock storage service
vi.mock('../00-storage/service', () => ({
  storageService: {
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    updateChatContent: vi.fn().mockResolvedValue(undefined),
    updateChatMeta: vi.fn().mockResolvedValue(undefined),
    updateHierarchy: vi.fn().mockResolvedValue(undefined),
    subscribeToChanges: vi.fn(),
    notify: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    loadChatGroup: vi.fn().mockResolvedValue(null),
    getFile: vi.fn(),
    canPersistBinary: true,
  },
}));

describe('useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction Thinking Abort', () => {
  const chatStore = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();
  const { TEST_ONLY: { __testOnlySetCurrentChat } } = chatStore;

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    mockLmChat.mockReset();
    chatStore.TEST_ONLY.clearLiveChatRegistry();
  });

  it('keeps the unfinished literal thinking text on abort without synthesizing a closing tag', async () => {
    const { sendMessage, abortChat, streaming } = chatStore;
    const chat = reactive<Chat>({
      id: toChatId({ raw: 'abort-thinking-test' }), title: 'Abort Thinking', root: { items: [] },
      createdAt: 1, updatedAt: 1, debugEnabled: false,
    });
    __testOnlySetCurrentChat({ chat });
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    mockLmChat.mockImplementationOnce(({ signal }) => createChatGenerationStream({ signal, run: async ({ writer, signal }) => {
      signal.addEventListener('abort', () => stopped.resolve(), { once: true });
      await writer.text({ type: 'text', text: '<think>I am thinking...' });
      started.resolve();
      await stopped.promise;
      return { type: 'interrupted', reason: 'aborted' };
    } }));
    try {
      await sendMessage({ content: 'Hello' });
      await started.promise;
      const assistant = chat.root.items[0]!.replies.items[0]!;
      await vi.waitUntil(() => getMessageText({ message: assistant }) === '<think>I am thinking...');
      expect(streaming.value).toBe(true);
      abortChat({ chatId: idToRaw({ id: chat.id }) });
      await vi.waitUntil(() => !streaming.value);
      expect(assistant.parts).toEqual([{ type: 'text', text: '<think>I am thinking...', completeness: 'partial' }]);
      expect(assistant.role === 'assistant' && assistant.interruption).toEqual({ type: 'cancelled' });
      expect(getMessageText({ message: assistant })).not.toContain('</think>');
      expect(getMessageText({ message: assistant })).not.toContain('[Generation Aborted]');
    } finally {
      abortChat({ chatId: undefined });
      stopped.resolve();
      await vi.waitUntil(() => !streaming.value);
    }
  });
});
