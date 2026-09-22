import type { LmProvider } from '@/01-models/lm';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { getMessageText } from '@/01-models/message-text';
import { idToRaw, toChatId, toMessageId } from '@/01-models/ids';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction } from './useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction';
import { storageService } from '@/00-storage/service';
import { reactive } from 'vue';
import type { SidebarItem, Hierarchy, AssistantMessageNode } from '@/01-models/types';
import { useGlobalEvents } from './useGlobalEvents';

// Mock storage service state
const mockRootItems: SidebarItem[] = [];
let mockHierarchy: Hierarchy = { items: [] };

// Mock LM Provider
const mockLm = {
  chat: vi.fn<LmProvider['chat']>(),
  generateImage: vi.fn(),
  listModels: vi.fn().mockResolvedValue(['gpt-4', 'x/z-image-turbo:v1']),
};

vi.mock('../01-models/lm', () => ({
  UNKNOWN_STEPS: Symbol('unknown'),
}));

vi.mock('../features/lm/openai', () => ({
  OpenAIProvider: vi.fn().mockImplementation(function() {
    return mockLm;
  }),
}));

vi.mock('../features/lm/ollama', () => ({
  OllamaProvider: vi.fn().mockImplementation(function() {
    return mockLm;
  }),
}));

vi.mock('../00-storage/service', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn().mockResolvedValue(undefined),
    loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation(({ updater }) => {
      return Promise.resolve(updater({ current: { root: { items: [] }, currentLeafId: undefined } })) as any;
    }),
    updateHierarchy: vi.fn().mockResolvedValue(undefined),
    loadHierarchy: vi.fn(),
    deleteChat: vi.fn(),
    updateChatGroup: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    loadChatGroup: vi.fn().mockResolvedValue(null),
    getSidebarStructure: vi.fn().mockImplementation(() => Promise.resolve([...mockRootItems])),
    deleteChatGroup: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    notify: vi.fn(),
    getFile: vi.fn().mockResolvedValue(new Blob(['test'], { type: 'image/png' })),
    saveFile: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock settings
vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpoint: { type: 'ollama', url: 'http://localhost' }, storageType: 'opfs', titleGeneration: 'disabled', defaultModelId: 'gpt-4' } },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
    setHeavyContentAlertDismissed: vi.fn(),
    setIsOnboardingDismissed: vi.fn(),
    setOnboardingDraft: vi.fn(),
  }),
}));

describe('useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction Interrupt and Sync Tests', () => {
  const chatStore = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();
  const {
    sendMessage, editMessage, regenerateMessage, TEST_ONLY,
  } = chatStore;
  const { __testOnlySetCurrentChat } = TEST_ONLY;

  const { clearEvents } = useGlobalEvents();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLm.chat.mockReset().mockImplementation(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ writer }) => {
        await writer.text({ type: 'text', text: 'Response' });
        return { type: 'finished', next: 'user' };
      },
    }));
    __testOnlySetCurrentChat({ chat: null });
    TEST_ONLY.activeGenerations.clear();
    TEST_ONLY.externalGenerations.clear();
    TEST_ONLY.activeTitleGenerations.clear();
    TEST_ONLY.activeContextCompactions.clear();
    TEST_ONLY.clearActiveTaskCounts();
    TEST_ONLY.clearLiveChatRegistry();
    mockRootItems.length = 0;
    mockHierarchy = { items: [] };
    clearEvents();

    vi.mocked(storageService.updateChatMeta).mockResolvedValue(undefined);
    vi.mocked(storageService.updateChatContent).mockImplementation(({ updater }) => {
      return Promise.resolve(updater({ current: { root: { items: [] }, currentLeafId: undefined } })) as any;
    });
    vi.mocked(storageService.loadHierarchy).mockImplementation(() => Promise.resolve(mockHierarchy));
    vi.mocked(storageService.updateHierarchy).mockImplementation(async ({ updater }) => {
      mockHierarchy = await updater({ current: mockHierarchy });
      return Promise.resolve();
    });
  });

  afterEach(async () => {
    await vi.waitUntil(() => TEST_ONLY.activeGenerations.size === 0);
  });

  it('should allow editMessage while generating by waiting for abort to finish', async () => {
    const chat = reactive({
      id: 'interrupt-test', title: 'Interrupt Test', root: { items: [] },
      modelId: 'gpt-4',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat({ chat });
    vi.mocked(storageService.loadChat).mockResolvedValue(chat);

    // 1. Start a slow regular chat generation
    const genStarted = Promise.withResolvers<AbortSignal>();
    mockLm.chat.mockImplementationOnce(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ signal }) => {
        genStarted.resolve(signal);
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { type: 'interrupted', reason: 'aborted' };
      },
    }));

    const sendResultPromise = sendMessage({ content: 'First version' });
    const signal = await genStarted.promise;
    expect(chatStore.isProcessing({ chatId: chat.id })).toBe(true);

    const userMsgId = chat.root.items[0].id;

    // 2. Edit the message while processing. This should now wait for isProcessing to become false.
    await editMessage({ messageId: userMsgId, newContent: 'Second version' });

    expect(chat.root.items).toHaveLength(2);
    expect(getMessageText({ message: chat.root.items[1]! })).toBe('Second version');
    expect(signal.aborted).toBe(true);

    await sendResultPromise;
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));
  }, 15000);

  it('should save intermediate image generation results to storage', async () => {
    const chatId = toChatId({ raw: 'sync-test' });
    const assistantId = toMessageId({ raw: 'assistant-1' });
    const chat = reactive({
      id: chatId, title: 'Sync Test',
      root: {
        items: [
          {
            id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'two cats', completeness: 'complete' }], modelId: undefined, lmParameters: undefined, createdAt: 0,
            replies: {
              items: [
                { id: assistantId, role: 'assistant', parts: [], modelId: undefined, lmParameters: undefined, interruption: undefined, createdAt: 0, replies: { items: [] } },
              ],
            },
          },
        ],
      },
      currentLeafId: assistantId,
      modelId: 'x/z-image-turbo:v1',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat({ chat });
    vi.mocked(storageService.loadChat).mockResolvedValue(chat);

    const { handleImageGeneration, availableModels } = chatStore;
    availableModels.value = ['gpt-4', 'x/z-image-turbo:v1'];

    mockLm.generateImage.mockResolvedValue({
      image: new Blob(['img'], { type: 'image/png' }),
      totalSteps: 10,
    });

    await handleImageGeneration({
      chatId: idToRaw({ id: chatId }),
      assistantId: idToRaw({ id: assistantId }),
      prompt: 'two cats',
      width: 512,
      height: 512,
      count: 2,
      steps: undefined,
      seed: undefined,
      persistAs: 'original',
      images: [],
      model: 'x/z-image-turbo:v1',
      signal: new AbortController().signal,
    });

    // 1 call before loop (initial sentinel) + 1 call per loop iteration (2 images) + 1 call in finally block = 4 calls
    expect(vi.mocked(storageService.updateChatContent).mock.calls.length).toBeGreaterThanOrEqual(4);
  }, 15000);

  it('should persist cancellation separately from accepted text when regular chat generation is aborted', async () => {
    const chatId = toChatId({ raw: 'abort-test' });
    const assistantId = toMessageId({ raw: 'assistant-1' });
    const chat = reactive({
      id: chatId, title: 'Abort Test',
      root: {
        items: [
          {
            id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Will be aborted', completeness: 'complete' }], modelId: undefined, lmParameters: undefined, createdAt: 0,
            replies: {
              items: [
                { id: assistantId, role: 'assistant', parts: [], modelId: undefined, lmParameters: undefined, interruption: undefined, createdAt: 0, replies: { items: [] } },
              ],
            },
          },
        ],
      },
      currentLeafId: assistantId,
      modelId: 'gpt-4',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat({ chat });
    vi.mocked(storageService.loadChat).mockResolvedValue(chat);

    // 1. Keep the provider running after delivering accepted text.
    mockLm.chat.mockImplementationOnce(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ writer, signal }) => {
        await writer.text({ type: 'text', text: 'Partial answer' });
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { type: 'interrupted', reason: 'aborted' };
      },
    }));

    const { generateResponse, abortChat, isProcessing } = chatStore;

    // 2. Start generation
    const genPromise = generateResponse({ chat: chat, assistantId: idToRaw({ id: assistantId }) });

    // 3. Wait for it to be processing
    await vi.waitUntil(() => isProcessing({ chatId }));
    await vi.waitUntil(() => getMessageText({ message: chat.root.items[0].replies.items[0] }) === 'Partial answer');

    // 4. Abort the chat
    abortChat({ chatId: idToRaw({ id: chatId }) });

    await genPromise;
    await vi.waitUntil(() => !isProcessing({ chatId }));

    // 5. Accepted text stays unchanged; cancellation is stored separately.
    const userMsg = chat.root.items[0];
    const assistantMsg = userMsg.replies.items[0];
    expect(getMessageText({ message: assistantMsg })).toBe('Partial answer');
    expect(assistantMsg.interruption).toEqual({ type: 'cancelled' });
    expect(assistantMsg.parts).toEqual([
      expect.objectContaining({ type: 'text', text: 'Partial answer', completeness: 'partial' }),
    ]);

    // 6. The saved content preserves both the accepted text and cancellation metadata.
    expect(vi.mocked(storageService.updateChatContent)).toHaveBeenCalled();
    const { updater } = vi.mocked(storageService.updateChatContent).mock.calls.at(-1)![0];
    const savedContent = await updater({ current: null });
    const savedAssistant = savedContent.root.items[0]!.replies.items[0] as AssistantMessageNode;
    expect(savedAssistant.interruption).toEqual({ type: 'cancelled' });
    expect(savedAssistant.parts).toEqual(assistantMsg.parts);
  }, 15000);

  it('should request external abort before regenerateMessage and continue', async () => {
    const chatId = toChatId({ raw: 'external-regen-test' });
    const assistantId = toMessageId({ raw: 'assistant-1' });
    const chat = reactive({
      id: chatId,
      title: 'External Regen',
      root: {
        items: [
          {
            id: 'user-1',
            role: 'user',
            parts: [{ type: 'text', text: 'Hello', completeness: 'complete' }], modelId: undefined, lmParameters: undefined,
            createdAt: 0,
            replies: {
              items: [
                {
                  id: assistantId,
                  role: 'assistant',
                  parts: [{ type: 'text', text: 'First answer', completeness: 'complete' }], interruption: undefined,
                  createdAt: 0,
                  replies: { items: [] },
                  modelId: 'gpt-4',
                  lmParameters: undefined,
                },
              ],
            },
          },
        ],
      },
      currentLeafId: assistantId,
      modelId: 'gpt-4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat({ chat });
    vi.mocked(storageService.loadChat).mockResolvedValue(chat);
    TEST_ONLY.externalGenerations.add(chatId);
    vi.mocked(storageService.notify).mockImplementation(({ event }: any) => {
      if (event.type === 'chat_content_generation' && event.status === 'abort_request' && event.id === chatId) {
        TEST_ONLY.externalGenerations.delete(chatId);
      }
    });

    mockLm.chat.mockImplementationOnce(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ writer }) => {
        await writer.text({ type: 'text', text: 'Regenerated' });
        return { type: 'finished', next: 'user' };
      },
    }));

    await regenerateMessage({ failedMessageId: idToRaw({ id: assistantId }) });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId }));

    expect(vi.mocked(storageService.notify)).toHaveBeenCalledWith({
      event: expect.objectContaining({
        type: 'chat_content_generation',
        id: chatId,
        status: 'abort_request',
      }),
    });
    expect(chat.root.items[0].replies.items).toHaveLength(2);
    expect(getMessageText({ message: chat.root.items[0].replies.items[1]! })).toBe('Regenerated');
  }, 15000);

  it('should abort active compact processing before editMessage and continue', async () => {
    const chatId = toChatId({ raw: 'compact-edit-test' });
    const chat = reactive({
      id: chatId,
      title: 'Compact Edit',
      root: {
        items: [
          {
            id: 'user-1',
            role: 'user',
            parts: [{ type: 'text', text: 'Original', completeness: 'complete' }], modelId: undefined, lmParameters: undefined,
            createdAt: 0,
            replies: {
              items: [
                {
                  id: toMessageId({ raw: 'assistant-1' }),
                  role: 'assistant',
                  parts: [{ type: 'text', text: 'Old response', completeness: 'complete' }], lmParameters: undefined, interruption: undefined,
                  createdAt: 0,
                  replies: { items: [] },
                  modelId: 'gpt-4',
                },
              ],
            },
          },
        ],
      },
      currentLeafId: toMessageId({ raw: 'assistant-1' }),
      modelId: 'gpt-4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat({ chat });
    vi.mocked(storageService.loadChat).mockResolvedValue(chat);

    const compactController = new AbortController();
    const compactAbort = vi.spyOn(compactController, 'abort').mockImplementation(() => {
      TEST_ONLY.activeContextCompactions.delete(chatId);
      TEST_ONLY.activeTaskCounts.delete(`process:${idToRaw({ id: chatId })}`);
    });
    TEST_ONLY.activeContextCompactions.set(chatId, compactController);
    TEST_ONLY.activeTaskCounts.set(`process:${idToRaw({ id: chatId })}`, 1);

    mockLm.chat.mockImplementationOnce(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ writer }) => {
        await writer.text({ type: 'text', text: 'Edited Response' });
        return { type: 'finished', next: 'user' };
      },
    }));

    await editMessage({ messageId: idToRaw({ id: toMessageId({ raw: 'user-1' }) }), newContent: 'Updated content' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId }));

    expect(compactAbort).toHaveBeenCalledTimes(1);
    expect(chat.root.items).toHaveLength(2);
    expect(getMessageText({ message: chat.root.items[1].replies.items[0]! })).toBe('Edited Response');
  }, 15000);
});
