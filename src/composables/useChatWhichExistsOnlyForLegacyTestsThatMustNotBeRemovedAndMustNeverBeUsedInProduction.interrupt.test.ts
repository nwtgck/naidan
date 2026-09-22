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

describe('useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction Interruption', () => {
  const chatStore = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();
  const { TEST_ONLY: { __testOnlySetCurrentChat } } = chatStore;

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    mockLmChat.mockReset();
    chatStore.TEST_ONLY.clearLiveChatRegistry();
  });

  it('should interrupt current generation and start new one when regenerateMessage is called', async () => {
    const { sendMessage, regenerateMessage, streaming } = chatStore;
    const chat = reactive<Chat>({
      id: toChatId({ raw: 'regen-interrupt-test' }), title: 'Regen Interrupt', root: { items: [] },
      createdAt: 1, updatedAt: 1, debugEnabled: false,
    });
    __testOnlySetCurrentChat({ chat });
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    let firstGenAborted = false;
    mockLmChat.mockImplementationOnce(({ signal }) => createChatGenerationStream({ signal, run: async ({ writer, signal }) => {
      signal.addEventListener('abort', () => {
        firstGenAborted = true; stopped.resolve();
      }, { once: true });
      await writer.text({ type: 'text', text: 'First chunk' });
      started.resolve();
      await stopped.promise;
      return { type: 'interrupted', reason: 'aborted' };
    } }));
    try {
      expect(await sendMessage({ content: 'Hello' })).toBe(true);
      await started.promise;
      const user = chat.root.items[0]!;
      const first = user.replies.items[0]!;
      await vi.waitUntil(() => getMessageText({ message: first }) === 'First chunk');
      mockLmChat.mockImplementationOnce(({ signal }) => createChatGenerationStream({ signal, run: async ({ writer }) => {
        await writer.text({ type: 'text', text: 'Second Response' });
        return { type: 'finished', next: 'user' };
      } }));
      await regenerateMessage({ failedMessageId: idToRaw({ id: first.id }) });
      await vi.waitUntil(() => !streaming.value);
      expect(firstGenAborted).toBe(true);
      expect(user.replies.items).toHaveLength(2);
      expect(first.parts).toMatchObject([{ type: 'text', text: 'First chunk', completeness: 'partial' }]);
      expect(first.role === 'assistant' && first.interruption).toEqual({ type: 'cancelled' });
      const second = user.replies.items[1]!;
      expect(second.id).not.toBe(first.id);
      expect(getMessageText({ message: second })).toBe('Second Response');
      expect(chat.currentLeafId).toBe(second.id);
      expect(mockLmChat.mock.calls[1]![0].messages.map(message => message.role)).toEqual(['user']);
    } finally {
      chatStore.abortChat({ chatId: undefined });
      stopped.resolve();
      await vi.waitUntil(() => !streaming.value);
    }
  });

  it('should interrupt current generation and start new one when editMessage (resend) is called', async () => {
    const { sendMessage, editMessage, streaming } = chatStore;
    const chat = reactive<Chat>({
      id: toChatId({ raw: 'edit-interrupt-test' }), title: 'Edit Interrupt', root: { items: [] },
      createdAt: 1, updatedAt: 1, debugEnabled: false,
    });
    __testOnlySetCurrentChat({ chat });
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    let firstGenAborted = false;
    mockLmChat.mockImplementationOnce(({ signal }) => createChatGenerationStream({ signal, run: async ({ writer, signal }) => {
      signal.addEventListener('abort', () => {
        firstGenAborted = true; stopped.resolve();
      }, { once: true });
      await writer.text({ type: 'text', text: 'First chunk' });
      started.resolve();
      await stopped.promise;
      return { type: 'interrupted', reason: 'aborted' };
    } }));
    try {
      await sendMessage({ content: 'Hello' });
      await started.promise;
      const user = chat.root.items[0]!;
      const first = user.replies.items[0]!;
      mockLmChat.mockImplementationOnce(({ signal }) => createChatGenerationStream({ signal, run: async ({ writer }) => {
        await writer.text({ type: 'text', text: 'Edited Response' });
        return { type: 'finished', next: 'user' };
      } }));
      await editMessage({ messageId: idToRaw({ id: user.id }), newContent: 'Hello Again' });
      await vi.waitUntil(() => !streaming.value);
      expect(firstGenAborted).toBe(true);
      expect(chat.root.items).toHaveLength(2);
      expect(getMessageText({ message: user })).toBe('Hello');
      expect(first.parts).toMatchObject([{ type: 'text', text: 'First chunk', completeness: 'partial' }]);
      expect(first.role === 'assistant' && first.interruption).toEqual({ type: 'cancelled' });
      const nextUser = chat.root.items[1]!;
      expect(getMessageText({ message: nextUser })).toBe('Hello Again');
      const second = nextUser.replies.items[0]!;
      expect(second.id).not.toBe(first.id);
      expect(getMessageText({ message: second })).toBe('Edited Response');
      expect(mockLmChat.mock.calls[1]![0].messages).toMatchObject([{ role: 'user', parts: [{ text: 'Hello Again' }] }]);
    } finally {
      chatStore.abortChat({ chatId: undefined });
      stopped.resolve();
      await vi.waitUntil(() => !streaming.value);
    }
  });
});
