import type { ChatId, MessageId } from '@/models/ids';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ChatPane from './ChatPane.vue';
import { nextTick, ref, reactive, computed } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';


import { setupScrollToMock } from '@/utils/test-utils';
import { idToRaw, toChatId } from '@/models/ids';

// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }],
});

import type { MessageNode, Chat } from '@/models/types';

// Mock dependencies
const mockSendMessage = vi.fn().mockResolvedValue(true);
const mockFetchAvailableModels = vi.fn().mockResolvedValue(['model-1']);
const mockStreaming = ref(false);
const mockIsTaskRunningValue = ref(false);
const mockAvailableModels = ref<string[]>([]);
const mockFetchingModels = ref(false);
const mockCurrentChat = ref<Chat | null>(null);
const mockActiveMessages = ref<MessageNode[]>([]);
const mockChatGroups = ref<any[]>([]);
const mockResolvedSettings = ref<any>(null);
const mockInheritedSettings = ref<any>(null);


vi.mock('@/composables/useAppPresentation', () => ({
  isAppInteractionEnabled: ({ interaction }: { interaction: string }) => interaction === 'enabled',
  useAppPresentation: () => ({
    appInteraction: {
      __v_isRef: true,
      value: 'enabled',
    },
  }),
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: ref(null),
    chatGroups: mockChatGroups,
    resolvedSettings: mockResolvedSettings.value || ref({ endpoint: { type: 'openai', url: 'http://localhost' }, lmParameters: { reasoning: { effort: undefined } } }),
    inheritedSettings: mockInheritedSettings,
    sendMessage: mockSendMessage,
    updateChatModel: vi.fn(),
    saveChat: vi.fn(),
    streaming: mockStreaming,
    activeGenerations: reactive(new Map()),
    toggleDebug: vi.fn(),
    activeMessages: mockActiveMessages,
    getSiblings: vi.fn().mockReturnValue([]),
    editMessage: vi.fn(),
    switchVersion: vi.fn(),
    abortChat: vi.fn(),
    availableModels: mockAvailableModels,
    fetchingModels: mockFetchingModels,
    generatingTitle: ref(false),
    fetchAvailableModels: mockFetchAvailableModels,
    generateChatTitle: vi.fn(),
    abortTitleGeneration: vi.fn(),
    forkChat: vi.fn().mockResolvedValue('new-id'),
    openChatGroup: vi.fn(),
    moveChatToGroup: vi.fn(),
    isTaskRunning: vi.fn((_id: string) => mockIsTaskRunningValue.value || mockStreaming.value),
    isProcessing: vi.fn((_id: string) => mockStreaming.value),
    isImageMode: vi.fn(() => false),
    toggleImageMode: vi.fn(),
    getResolution: vi.fn(() => ({ width: 512, height: 512 })),
    getCount: vi.fn(() => 1),
    updateCount: vi.fn(),
    getPersistAs: vi.fn(() => 'original'),
    updatePersistAs: vi.fn(),
    updateResolution: vi.fn(),
    getSteps: vi.fn(() => undefined),
    updateSteps: vi.fn(),
    getSeed: vi.fn(() => 'browser_random'),
    updateSeed: vi.fn(),
    setImageModel: vi.fn(),
    getSelectedImageModel: vi.fn(),
    getSortedImageModels: vi.fn(() => []),
    imageModeMap: ref({}),
    imageResolutionMap: ref({}),
    imageCountMap: ref({}),
    imagePersistAsMap: ref({}),
    imageModelOverrideMap: ref({}),
    getReasoningEffort: vi.fn(),
    updateReasoningEffort: vi.fn(),
    updateChatSettings: vi.fn(),
    getLiveChat: vi.fn().mockImplementation((c) => c),
    chatFlow: computed(() => mockActiveMessages.value.map(m => ({
      type: 'message',
      node: m,
      mode: 'content',
      flow: { position: 'standalone', nesting: 'none' },
      isFirstInNode: true,
      isLastInNode: true,
      isFirstInTurn: true,
    }))),
    isThinkingActive: vi.fn(() => false),
    isWaitingResponse: vi.fn(() => false),
  }),
}));

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChat: computed(() => mockCurrentChat.value),
    currentChatGroup: computed(() => null),
    currentChatId: computed(() => mockCurrentChat.value?.id),
    activeMessages: computed(() => mockActiveMessages.value),
    allMessages: computed(() => mockActiveMessages.value),
    resolvedSettings: computed(() => mockResolvedSettings.value),
    inheritedSettings: computed(() => mockInheritedSettings.value),
    chatGroups: computed(() => mockChatGroups.value),
  }),
}));

vi.mock('../composables/chat/ui/useChatPaneState', () => ({
  useChatPaneState: () => ({
    chat: computed(() => mockCurrentChat.value),
    chatGroup: computed(() => null),
    activeMessages: computed(() => mockActiveMessages.value),
    allMessages: computed(() => mockActiveMessages.value),
    resolvedSettings: computed(() => mockResolvedSettings.value),
    inheritedSettings: computed(() => mockInheritedSettings.value),
    chatGroups: computed(() => mockChatGroups.value),
  }),
}));

vi.mock('../composables/chat/chat-activity-queries', () => ({
  isChatProcessing: ({ chatId }: { chatId: string }) =>
    !!mockCurrentChat.value && idToRaw({ id: mockCurrentChat.value.id }) === chatId && mockStreaming.value,
  getChatContextCompactProgress: () => ({ phase: 'idle' }),
  isChatGeneratingTitle: () => false,
}));

function mountChatPane({
  props,
  global,
}: {
  props?: {
    chatId?: ChatId,
    autoSendPrompt?: string,
    targetMessageId?: MessageId,
  },
  global?: Record<string, unknown>,
} = {}) {
  return mount(ChatPane, {
    props: {
      chatId: props?.chatId ?? mockCurrentChat.value?.id ?? toChatId({ raw: 'chat-1' }),
      autoSendPrompt: props?.autoSendPrompt,
      targetMessageId: props?.targetMessageId,
    },
    global,
  });
}

vi.mock('../composables/chat/useChatConversation', () => ({
  useChatConversation: () => ({
    sendMessage: ({
      content,
      parentId,
      attachments,
      lmParameters,
    }: {
      chatId: string,
      content: string,
      parentId: string | null | undefined,
      attachments: unknown[] | undefined,
      lmParameters: unknown,
    }) => mockSendMessage({
      content,
      parentId,
      attachments: attachments ?? [],
      chatTarget: undefined,
      lmParameters,
    }),
    regenerateMessage: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatModels', () => ({
  useChatModels: () => ({
    availableModels: mockAvailableModels,
    fetchingModels: computed(() => mockFetchingModels.value),
    fetchForChat: () => mockFetchAvailableModels(),
    fetchForGlobalEndpoint: vi.fn(),
    fetchForEndpoint: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatMounts', () => ({
  useChatMounts: () => ({
    getMounts: () => computed(() => []),
    addMount: vi.fn(),
    removeMount: vi.fn(),
    updateMount: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatMetadata', () => ({
  useChatMetadata: () => ({
    reasoningEffort: () => computed(() => undefined),
    updateReasoningEffort: vi.fn(),
    updateModel: vi.fn(),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatGeneration', () => ({
  useChatGeneration: () => ({
    sendMessage: ({
      content,
      parentId,
      attachments,
      lmParameters,
    }: {
      content: string,
      parentId: string | null | undefined,
      attachments: unknown[] | undefined,
      lmParameters: unknown,
    }) => mockSendMessage({
      content,
      parentId,
      attachments: attachments ?? [],
      chatTarget: undefined,
      lmParameters,
    }),
    regenerateMessage: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatModelSelection', () => ({
  useChatModelSelection: () => ({
    availableModels: mockAvailableModels,
    fetchingModels: computed(() => mockFetchingModels.value),
    fetchModels: () => mockFetchAvailableModels(),
    updateModel: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatImageGeneration', () => ({
  useChatImageGeneration: () => ({
    availableModels: mockAvailableModels,
    isImageMode: computed(() => false),
    resolution: computed(() => ({ width: 512, height: 512 })),
    count: computed(() => 1),
    persistAs: computed(() => 'original'),
    steps: computed(() => undefined),
    seed: computed(() => 'browser_random'),
    selectedImageModel: computed(() => undefined),
    toggleImageMode: vi.fn(),
    updateResolution: vi.fn(),
    updateCount: vi.fn(),
    updatePersistAs: vi.fn(),
    updateSteps: vi.fn(),
    updateSeed: vi.fn(),
    setImageModel: vi.fn(),
    sendImageRequest: vi.fn().mockResolvedValue(true),
  }),
}));

vi.mock('../composables/chat/useChatImageProgress', () => ({
  useChatImageProgress: () => ({
    progress: computed(() => undefined),
    currentStep: computed(() => undefined),
    totalSteps: computed(() => undefined),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpoint: { type: 'openai', url: 'http://localhost' }, defaultModelId: 'global-default-model' }),
    availableModels: mockAvailableModels,
    isFetchingModels: mockFetchingModels,
    fetchModels: mockFetchAvailableModels,
  }),
}));

// Mock Mermaid
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}));

describe('ChatPane Auto-send', () => {
  beforeEach(() => {
    setupScrollToMock();
    vi.clearAllMocks();
    mockCurrentChat.value = {
      id: toChatId({ raw: '1' }),
      title: 'Test Chat',
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockResolvedSettings.value = {
      endpoint: { type: 'openai', url: 'http://localhost' },
      modelId: 'model-1',
      sources: { endpoint: 'global', modelId: 'global' },
    };
    mockSendMessage.mockResolvedValue(true);
  });

  it('should wait for currentChat to be available before auto-sending', async () => {
    mockCurrentChat.value = null;

    const wrapper = mountChatPane( {
      props: {
        autoSendPrompt: 'hello',
      },
      global: { plugins: [router] },
    });

    expect(mockSendMessage).not.toHaveBeenCalled();

    // Now set currentChat
    mockCurrentChat.value = {
      id: toChatId({ raw: '1' }),
      title: 'Test Chat',
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockSendMessage).toHaveBeenCalledWith({ content: 'hello', parentId: undefined, attachments: [], chatTarget: undefined, lmParameters: expect.anything() });
    expect(wrapper.emitted('auto-sent')).toBeTruthy();
  });

  it('should not clear input if sendMessage fails', async () => {
    mockSendMessage.mockResolvedValue(false);

    const wrapper = mountChatPane( {
      props: {
        autoSendPrompt: 'hello',
      },
      global: { plugins: [router] },
    });

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockSendMessage).toHaveBeenCalled();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    expect(textarea.element.value).toBe('hello');
    expect(wrapper.emitted('auto-sent')).toBeTruthy(); // It still emits auto-sent because it tried
  });

  it('should NOT return early in handleSend if only fetching models', async () => {
    // Simulate fetching models
    mockIsTaskRunningValue.value = true;

    mountChatPane( {
      props: {
        autoSendPrompt: 'hello',
      },
      global: { plugins: [router] },
    });

    await flushPromises();
    await nextTick();
    await nextTick();

    // If it returns early, mockSendMessage won't be called
    expect(mockSendMessage).toHaveBeenCalledWith({ content: 'hello', parentId: undefined, attachments: [], chatTarget: undefined, lmParameters: expect.anything() });
  });
});
