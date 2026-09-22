import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { LmProvider } from '@/01-models/lm';
import { getMessageText } from '@/01-models/message-text';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { createAsyncChannel } from '@/utils/async-channel';
import { useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction } from './useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction';
import { nextTick } from 'vue';

// Mock storage
vi.mock('../00-storage/service', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    loadChatMeta: vi.fn(),
    loadChatContent: vi.fn().mockResolvedValue(null),
    updateHierarchy: vi.fn().mockImplementation(({ updater }) => updater({ current: { items: [] } })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    deleteChat: vi.fn(),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    updateChatMeta: vi.fn().mockResolvedValue(undefined),
    updateChatContent: vi.fn().mockResolvedValue(undefined),
    loadChatGroup: vi.fn().mockResolvedValue(null),
    notify: vi.fn(),
  },
}));

// Mock settings
vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpoint: { type: 'openai', url: 'http://localhost' }, storageType: 'local', defaultModelId: 'gpt-4', titleGeneration: 'disabled' } },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

// Mock LM
let chunks: ReturnType<typeof createAsyncChannel<string>>;
vi.mock('../features/lm/openai', () => {
  class MockOpenAI {
    chat = vi.fn<LmProvider['chat']>().mockImplementation(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ writer }) => {
        for await (const text of chunks.values) {
          await writer.text({ type: 'text', text });
        }
        return { type: 'finished', next: 'user' };
      },
    }));
    listModels = vi.fn().mockResolvedValue([]);
  }
  return {
    OpenAIProvider: MockOpenAI,
  };
});

vi.mock('../features/lm/ollama', () => ({
  OllamaProvider: vi.fn(),
}));

describe('useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction Reactivity', () => {
  const chatStore = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();

  beforeEach(() => {
    vi.clearAllMocks();
    chatStore.TEST_ONLY.clearLiveChatRegistry();
    chunks = createAsyncChannel<string>({ capacity: 4, onCancel: () => {} });
  });

  afterEach(async () => {
    chunks.close();
    await vi.waitUntil(() => chatStore.TEST_ONLY.activeGenerations.size === 0);
  });

  it('should reflect streamed chunks in activeMessages immediately', async () => {
    await chatStore.createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chat = chatStore.currentChat.value!;

    // Start sending
    void chatStore.sendMessage({ content: 'Hello' });

    // Wait for activeGenerations to have the chat (signals generation started)
    await vi.waitUntil(() => chatStore.TEST_ONLY.activeGenerations.has(chat.id), { timeout: 2000 });

    expect(chatStore.activeMessages.value).toHaveLength(2);
    expect(getMessageText({ message: chatStore.activeMessages.value[1]! })).toBe('');

    // Simulate chunk
    await chunks.send({ value: 'A' });
    await flushPromises();
    await nextTick();
    expect(getMessageText({ message: chatStore.activeMessages.value[1]! })).toBe('A');
    expect(chatStore.TEST_ONLY.activeGenerations.has(chat.id)).toBe(true);

    await chunks.send({ value: 'B' });
    await flushPromises();
    await nextTick();
    expect(getMessageText({ message: chatStore.activeMessages.value[1]! })).toBe('AB');
    expect(chatStore.TEST_ONLY.activeGenerations.has(chat.id)).toBe(true);
  });
});
