import { idToRaw, toChatId, toMessageId } from '@/models/ids';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '@/services/storage';
import { reactive } from 'vue';
import type { SidebarItem, Hierarchy } from '@/models/types';
import { useGlobalEvents } from './useGlobalEvents';

// Mock storage service state
const mockRootItems: SidebarItem[] = [];
let mockHierarchy: Hierarchy = { items: [] };

// Mock LLM Provider
const mockLlm = {
  chat: vi.fn(),
  generateImage: vi.fn(),
  listModels: vi.fn().mockResolvedValue(['gpt-4', 'x/z-image-turbo:v1']),
};

vi.mock('../services/lm/types', () => ({
  UNKNOWN_STEPS: Symbol('unknown'),
}));

vi.mock('../services/lm/openai', () => ({
  OpenAIProvider: vi.fn().mockImplementation(function() {
    return mockLlm;
  }),
}));

vi.mock('../services/lm/ollama', () => ({
  OllamaProvider: vi.fn().mockImplementation(function() {
    return mockLlm;
  }),
}));

vi.mock('../services/storage', () => ({
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
    settings: { value: { endpointType: 'ollama', endpointUrl: 'http://localhost', storageType: 'opfs', autoTitleEnabled: false, defaultModelId: 'gpt-4' } },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
    setHeavyContentAlertDismissed: vi.fn(),
    setIsOnboardingDismissed: vi.fn(),
    setOnboardingDraft: vi.fn(),
  }),
}));

describe('useChat Interrupt and Sync Tests', () => {
  const chatStore = useChat();
  const {
    sendMessage, editMessage, regenerateMessage, TEST_ONLY
  } = chatStore;
  const { __testOnlySetCurrentChat } = TEST_ONLY;

  const { clearEvents } = useGlobalEvents();

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('should allow editMessage while generating by waiting for abort to finish', async () => {
    const chat = reactive({
      id: 'interrupt-test', title: 'Interrupt Test', root: { items: [] },
      modelId: 'gpt-4',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat({ chat });
    vi.mocked(storageService.loadChat).mockResolvedValue(chat);

    // 1. Start a slow regular chat generation
    let resolveGen: (value: any) => void;
    const genStarted = new Promise<any>(resolve => resolveGen = resolve);

    mockLlm.chat.mockImplementation(async (params: any) => {
      resolveGen(params.signal);
      return new Promise((resolve) => {
        const checkAbort = () => {
          if (params.signal?.aborted) {
            resolve(null);
          } else {
            setTimeout(checkAbort, 10);
          }
        };
        checkAbort();
      });
    });

    const sendResultPromise = sendMessage({ content: 'First version' });
    const signal = await genStarted;
    expect(chatStore.isProcessing({ chatId: chat.id })).toBe(true);

    const userMsgId = chat.root.items[0].id;

    // 2. Edit the message while processing. This should now wait for isProcessing to become false.
    await editMessage({ messageId: userMsgId, newContent: 'Second version' });

    expect(chat.root.items).toHaveLength(2);
    expect(chat.root.items[1].content).toBe('Second version');
    expect(signal.aborted).toBe(true);

    await sendResultPromise;
  }, 15000);

  it('should save intermediate image generation results to storage', async () => {
    const chatId = toChatId({ raw: 'sync-test' });
    const assistantId = toMessageId({ raw: 'assistant-1' });
    const chat = reactive({
      id: chatId, title: 'Sync Test',
      root: {
        items: [
          {
            id: 'user-1', role: 'user', content: 'two cats', timestamp: 0,
            replies: {
              items: [
                { id: assistantId, role: 'assistant', content: '', timestamp: 0, replies: { items: [] } }
              ]
            }
          }
        ]
      },
      currentLeafId: assistantId,
      modelId: 'x/z-image-turbo:v1',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat({ chat });
    vi.mocked(storageService.loadChat).mockResolvedValue(chat);

    const { handleImageGeneration, availableModels } = chatStore;
    availableModels.value = ['gpt-4', 'x/z-image-turbo:v1'];

    mockLlm.generateImage.mockResolvedValue({
      image: new Blob(['img'], { type: 'image/png' }),
      totalSteps: 10
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
      signal: new AbortController().signal
    });

    // 1 call before loop (initial sentinel) + 1 call per loop iteration (2 images) + 1 call in finally block = 4 calls
    expect(vi.mocked(storageService.updateChatContent).mock.calls.length).toBeGreaterThanOrEqual(4);
  }, 15000);

  it('should save "[Generation Aborted]" suffix to storage when regular chat generation is aborted', async () => {
    const chatId = toChatId({ raw: 'abort-test' });
    const assistantId = toMessageId({ raw: 'assistant-1' });
    const chat = reactive({
      id: chatId, title: 'Abort Test',
      root: {
        items: [
          {
            id: 'user-1', role: 'user', content: 'Will be aborted', timestamp: 0,
            replies: {
              items: [
                { id: assistantId, role: 'assistant', content: '', timestamp: 0, replies: { items: [] } }
              ]
            }
          }
        ]
      },
      currentLeafId: assistantId,
      modelId: 'gpt-4',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat({ chat });
    vi.mocked(storageService.loadChat).mockResolvedValue(chat);

    // 1. Mock LLM to simulate an abortion
    mockLlm.chat.mockImplementation(async ({ signal }: any) => {
      return new Promise((_resolve, reject) => {
        const abortHandler = () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener('abort', abortHandler);
      });
    });

    const { generateResponse, abortChat, isProcessing } = chatStore;

    // 2. Start generation
    const genPromise = generateResponse({ chat: chat, assistantId: idToRaw({ id: assistantId }) });

    // 3. Wait for it to be processing
    await vi.waitUntil(() => isProcessing({ chatId }));

    // 4. Abort the chat
    abortChat({ chatId: idToRaw({ id: chatId }) });

    await genPromise;
    await vi.waitUntil(() => !isProcessing({ chatId }));

    // 5. Verify that the reactive assistant node was updated with the aborted message
    const userMsg = chat.root.items[0];
    const assistantMsg = userMsg.replies.items[0];
    expect(assistantMsg.content).toContain('[Generation Aborted]');

    // 6. Verify that storageService.updateChatContent was called for the AbortError suffix
    expect(vi.mocked(storageService.updateChatContent)).toHaveBeenCalled();
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
            content: 'Hello',
            timestamp: 0,
            replies: {
              items: [
                {
                  id: assistantId,
                  role: 'assistant',
                  content: 'First answer',
                  timestamp: 0,
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

    mockLlm.chat.mockImplementationOnce(async (params: any) => {
      params.onChunk({ chunk: 'Regenerated' });
    });

    await regenerateMessage({ failedMessageId: idToRaw({ id: assistantId }) });

    expect(vi.mocked(storageService.notify)).toHaveBeenCalledWith({
      event: expect.objectContaining({
        type: 'chat_content_generation',
        id: chatId,
        status: 'abort_request',
      }),
    });
    expect(chat.root.items[0].replies.items).toHaveLength(2);
    expect(chat.root.items[0].replies.items[1].content).toBe('Regenerated');
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
            content: 'Original',
            timestamp: 0,
            replies: {
              items: [
                {
                  id: toMessageId({ raw: 'assistant-1' }),
                  role: 'assistant',
                  content: 'Old response',
                  timestamp: 0,
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

    mockLlm.chat.mockImplementationOnce(async (params: any) => {
      params.onChunk({ chunk: 'Edited Response' });
    });

    await editMessage({ messageId: idToRaw({ id: toMessageId({ raw: 'user-1' }) }), newContent: 'Updated content' });
    await vi.waitUntil(() => !chatStore.streaming.value);

    expect(compactAbort).toHaveBeenCalledTimes(1);
    expect(chat.root.items).toHaveLength(2);
    expect(chat.root.items[1].replies.items[0].content).toBe('Edited Response');
  }, 15000);
});
