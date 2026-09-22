import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction } from './useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction';
import { useSettings } from './useSettings';
import { idToRaw } from '@/01-models/ids';
import type { LmProvider } from '@/01-models/lm';
import { getMessageText } from '@/01-models/message-text';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { ensureAllStringsForTest } from '@/strings/test-utils';

// Mock dependencies
vi.mock('../00-storage/service', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn(), loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation(({ updater }) => Promise.resolve(updater({ current: { root: { items: [] }, currentLeafId: undefined } }))),
    updateHierarchy: vi.fn().mockImplementation(({ updater }) => updater({ current: { items: [] } })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    loadSettings: vi.fn().mockResolvedValue({}),
    saveFile: vi.fn(),
    getFile: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
    loadChatGroup: vi.fn().mockResolvedValue(null),
    notify: vi.fn(),
    canPersistBinary: true,
    getCurrentType: vi.fn().mockReturnValue('local'),
  },
}));

// Mock LM with classes
const mockChat = vi.fn<LmProvider['chat']>();
const mockListModels = vi.fn().mockResolvedValue(['gpt-4']);

vi.mock('../features/lm/openai', () => ({
  OpenAIProvider: class {
    listModels = mockListModels;
    chat = mockChat;
  },
}));

vi.mock('../features/lm/ollama', () => ({
  OllamaProvider: class {
    listModels = mockListModels;
    chat = mockChat;
  },
}));

describe('useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction Error Handling', () => {
  const { TEST_ONLY: { __testOnlySetSettings } } = useSettings();

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction().TEST_ONLY.clearLiveChatRegistry();
    mockChat.mockReset();
    mockListModels.mockResolvedValue(['gpt-4']);

    __testOnlySetSettings({ newSettings: {
      endpoint: { type: 'openai', url: 'https://api.openai.com' },
      defaultModelId: 'gpt-4',
      titleGeneration: 'disabled',
      storageType: 'local',
      providerProfiles: [],
      mounts: [],
      heavyContentAlertDismissed: true,
    } });
  });

  it('should set error state on assistant node when generation fails', async () => {
    const chatStore = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();
    const { createNewChat, sendMessage, activeMessages } = chatStore;
    await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });

    // Setup failure
    mockChat.mockImplementation(({ signal }) => createChatGenerationStream({ signal, run: async () => {
      throw new Error('API Error');
    } }));

    await sendMessage({ content: 'Hello' });
    // Wait for the background generation task to fail
    await vi.waitUntil(() => !chatStore.streaming.value);

    const assistantMsg = activeMessages.value.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.interruption).toEqual({ type: 'error', message: 'API Error' });
    expect(assistantMsg?.parts).toEqual([]);
  });

  it('should retry message by creating a sibling node', async () => {
    const chatStore = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();
    const { createNewChat, sendMessage, activeMessages, regenerateMessage, currentChat } = chatStore;
    await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });

    // 1. Fail first
    mockChat.mockImplementationOnce(({ signal }) => createChatGenerationStream({ signal, run: async () => {
      throw new Error('First Fail');
    } }));

    await sendMessage({ content: 'Hello' });
    await vi.waitUntil(() => !chatStore.streaming.value); // Wait for first fail
    const failedMsg = activeMessages.value.find(m => m.role === 'assistant');
    expect(failedMsg?.interruption).toEqual({ type: 'error', message: 'First Fail' });

    // 2. Retry (Success)
    // The next call to mockChat (for retry) should succeed
    mockChat.mockImplementation(({ signal }) => createChatGenerationStream({ signal, run: async ({ writer }) => {
      await writer.text({ type: 'text', text: 'Success' });
      return { type: 'finished', next: 'user' };
    } }));

    await regenerateMessage({ failedMessageId: idToRaw({ id: failedMsg!.id }) });
    await vi.waitUntil(() => !chatStore.streaming.value); // Wait for success retry

    // Should have a NEW assistant message at the end
    const newMsg = activeMessages.value[activeMessages.value.length - 1];
    expect(newMsg?.id).not.toBe(failedMsg?.id);
    expect(newMsg?.role).toBe('assistant');
    expect(getMessageText({ message: newMsg! })).toBe('Success');
    expect(newMsg?.role === 'assistant' && newMsg.interruption).toBeUndefined();

    // Verify sibling structure
    const userMsg = activeMessages.value[0]!;
    const userNode = currentChat.value?.root.items.find(n => n.id === userMsg.id);
    expect(userNode).toBeDefined();
    const retained = userNode!.replies.items[0]!;
    expect(retained.role === 'assistant' && retained.interruption).toEqual({ type: 'error', message: 'First Fail' });
    expect(getMessageText({ message: userNode!.replies.items[1]! })).toBe('Success');
  });
});
