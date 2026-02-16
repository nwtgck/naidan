import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import { reactive } from 'vue';
import type { SidebarItem, Hierarchy } from '../models/types';
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

vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: vi.fn().mockImplementation(function() {
      return mockLlm;
    }),
    OllamaProvider: vi.fn().mockImplementation(function() {
      return mockLlm;
    }),
  };
});

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn().mockResolvedValue(undefined),
    loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation((_id, updater) => {
      return Promise.resolve(updater({ root: { items: [] }, currentLeafId: undefined })) as any;
    }),
    updateHierarchy: vi.fn().mockResolvedValue(undefined),
    loadHierarchy: vi.fn(),
    deleteChat: vi.fn(),
    updateChatGroup: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
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
    sendMessage, editMessage, __testOnly
  } = chatStore;
  const { __testOnlySetCurrentChat } = __testOnly;

  const { clearEvents } = useGlobalEvents();

  beforeEach(() => {
    vi.clearAllMocks();
    __testOnlySetCurrentChat(null);
    __testOnly.activeGenerations.clear();
    __testOnly.clearActiveTaskCounts();
    __testOnly.clearLiveChatRegistry();
    mockRootItems.length = 0;
    mockHierarchy = { items: [] };
    clearEvents();

    vi.mocked(storageService.updateChatMeta).mockResolvedValue(undefined);
    vi.mocked(storageService.updateChatContent).mockImplementation((_id, updater) => {
      return Promise.resolve(updater({ root: { items: [] }, currentLeafId: undefined })) as any;
    });
    vi.mocked(storageService.loadHierarchy).mockImplementation(() => Promise.resolve(mockHierarchy));
    vi.mocked(storageService.updateHierarchy).mockImplementation(async (updater) => {
      mockHierarchy = await updater(mockHierarchy);
      return Promise.resolve();
    });
  });

  it('should allow editMessage while generating by waiting for abort to finish', async () => {
    const chat = reactive({
      id: 'interrupt-test', title: 'Interrupt Test', root: { items: [] },
      modelId: 'gpt-4',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    }) as any;
    __testOnlySetCurrentChat(chat);
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

    const sendResultPromise = sendMessage('First version');
    const signal = await genStarted;
    expect(chatStore.isProcessing(chat.id)).toBe(true);

    const userMsgId = chat.root.items[0].id;

    // 2. Edit the message while processing. This should now wait for isProcessing to become false.
    await editMessage(userMsgId, 'Second version');

    expect(chat.root.items).toHaveLength(2);
    expect(chat.root.items[1].content).toBe('Second version');
    expect(signal.aborted).toBe(true);

    await sendResultPromise;
  }, 15000);

  it('should save intermediate image generation results to storage', async () => {
    const chatId = 'sync-test';
    const assistantId = 'assistant-1';
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
    __testOnlySetCurrentChat(chat);
    vi.mocked(storageService.loadChat).mockResolvedValue(chat);

    const { handleImageGeneration, availableModels } = chatStore;
    availableModels.value = ['gpt-4', 'x/z-image-turbo:v1'];

    mockLlm.generateImage.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));

    await handleImageGeneration({
      chatId,
      assistantId,
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
    const chatId = 'abort-test';
    const assistantId = 'assistant-1';
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
    __testOnlySetCurrentChat(chat);
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
    const genPromise = generateResponse(chat, assistantId);

    // 3. Wait for it to be processing
    await vi.waitUntil(() => isProcessing(chatId));

    // 4. Abort the chat
    abortChat(chatId);

    await genPromise;
    await vi.waitUntil(() => !isProcessing(chatId));

    // 5. Verify that the reactive assistant node was updated with the aborted message
    const userMsg = chat.root.items[0];
    const assistantMsg = userMsg.replies.items[0];
    expect(assistantMsg.content).toContain('[Generation Aborted]');

    // 6. Verify that storageService.updateChatContent was called for the AbortError suffix
    expect(vi.mocked(storageService.updateChatContent)).toHaveBeenCalled();
  }, 15000);
});
