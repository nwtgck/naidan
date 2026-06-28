import type { ChatId, MessageId } from '@/models/ids';
import { toChatId } from '@/models/ids';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatPane from './ChatPane.vue';
import { nextTick, ref, computed, reactive } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { useChat } from '@/composables/useChat';
import type { Attachment, LmParameters } from '@/models/types';


import { setupScrollToMock } from '@/utils/test-utils';


vi.mock('@/composables/useApplicationPresentation', () => ({
  isApplicationInteractionEnabled: ({ interaction }: { interaction: string }) => interaction === 'enabled',
  useApplicationPresentation: () => ({
    applicationInteraction: {
      __v_isRef: true,
      value: 'enabled',
    },
  }),
}));

// --- Mocks ---

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }],
});

const mockActiveGenerations = reactive(new Map());
const mockCurrentChat = ref<any>(null);
const mockActiveMessages = ref<any[]>([]);
const mockChatGroups = ref<any[]>([]);
const mockResolvedSettings = ref<any>({
  lmParameters: { reasoning: { effort: undefined } },
  modelId: 'm1',
  sources: { modelId: 'global' },
});
const mockInheritedSettings = ref<any>({ modelId: 'm1', sources: { modelId: 'global' } });

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    streaming: computed(() => mockActiveGenerations.size > 0),
    activeGenerations: mockActiveGenerations,
    generatingTitle: ref(false),
    generateChatTitle: vi.fn(),
    abortTitleGeneration: vi.fn(),
    activeMessages: mockActiveMessages,
    fetchingModels: ref(false),
    fetchAvailableModels: vi.fn(),
    getSiblings: vi.fn().mockReturnValue([]),
    saveChat: vi.fn(),
    moveChatToGroup: vi.fn(),
    chatGroups: mockChatGroups,
    resolvedSettings: mockResolvedSettings,
    inheritedSettings: mockInheritedSettings,
    availableModels: ref([]),
    isTaskRunning: vi.fn((id: string) => mockActiveGenerations.has(id)),
    isProcessing: vi.fn((id: string) => mockActiveGenerations.has(id)),
    abortChat: vi.fn(),
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


function mountChatPane({
  props,
  attachTo,
  global,
}: {
  props?: {
    chatId?: ChatId,
    autoSendPrompt?: string,
    targetMessageId?: MessageId,
  },
  attachTo?: Element | string,
  global?: Record<string, unknown>,
} = {}) {
  return mount(ChatPane, {
    props: {
      chatId: props?.chatId ?? mockCurrentChat.value?.id ?? toChatId({ raw: '1' }),
      autoSendPrompt: props?.autoSendPrompt,
      targetMessageId: props?.targetMessageId,
    },
    attachTo,
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
      attachments: Attachment[] | undefined,
      lmParameters: LmParameters | undefined,
    }) => useChat().sendMessage({
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
    availableModels: ref([]),
    fetchingModels: computed(() => false),
    fetchForChat: vi.fn(),
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
      attachments: Attachment[] | undefined,
      lmParameters: LmParameters | undefined,
    }) => useChat().sendMessage({
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
    availableModels: ref([]),
    fetchingModels: computed(() => false),
    fetchModels: vi.fn(),
    updateModel: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatImageGeneration', () => ({
  useChatImageGeneration: () => ({
    availableModels: ref([]),
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
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', defaultModelId: 'gpt-4' } },
  }),
}));

describe('ChatPane Concurrency Button State', () => {
  beforeEach(() => {
    setupScrollToMock();
    vi.clearAllMocks();
    mockActiveGenerations.clear();
    mockCurrentChat.value = null;
  });

  it('should show Send button in an idle chat even if another chat is streaming', async () => {
    // 1. Setup Chat A (Streaming)
    const chatAId = 'chat-a';
    mockActiveGenerations.set(chatAId, { controller: new AbortController(), chat: { id: chatAId } });

    // 2. Setup Chat B (Idle - the current one)
    const chatBId = 'chat-b';
    mockCurrentChat.value = {
      id: chatBId,
      title: 'Chat B',
      root: { items: [] },
      updatedAt: Date.now(),
    };

    const wrapper = mountChatPane( {
      global: {
        plugins: [router],
        stubs: {
          MessageItem: true,
          ChatSettingsPanel: true,
          WelcomeScreen: true,
          ModelSelector: true,
        },
      },
    });

    await nextTick();

    const sendButton = wrapper.find('[data-testid="send-button"]');
    const abortButton = wrapper.find('[data-testid="abort-button"]');

    expect(abortButton.exists()).toBe(false);
    expect(sendButton.exists()).toBe(true);
  });

  it('should allow sending a message in an idle chat even if another chat is streaming', async () => {
    // 1. Setup Chat A (Streaming)
    const chatAId = 'chat-a';
    mockActiveGenerations.set(chatAId, { controller: new AbortController(), chat: { id: chatAId } });

    // 2. Setup Chat B (Idle - current)
    const chatBId = 'chat-b';
    mockCurrentChat.value = {
      id: chatBId,
      title: 'Chat B',
      root: { items: [] },
      updatedAt: Date.now(),
    };

    const mockSendMessage = vi.fn();
    // We need to return the mock in the useChat implementation
    vi.spyOn(await import('@/composables/useChat'), 'useChat').mockReturnValue({
      currentChat: mockCurrentChat,
      streaming: computed(() => mockActiveGenerations.size > 0),
      activeGenerations: mockActiveGenerations,
      generatingTitle: ref(false),
      activeMessages: computed(() => []),
      fetchingModels: ref(false),
      fetchAvailableModels: vi.fn(),
      getSiblings: vi.fn().mockReturnValue([]),
      sendMessage: mockSendMessage, // The spy
      saveChat: vi.fn(),
      moveChatToGroup: vi.fn(),
      chatGroups: ref([]),
      isTaskRunning: vi.fn((id: string) => mockActiveGenerations.has(id)),
      isProcessing: vi.fn((id: string) => mockActiveGenerations.has(id)),
      abortChat: vi.fn(),
      resolvedSettings: ref({ modelId: 'm1', sources: { modelId: 'global' } }),
      inheritedSettings: ref({ modelId: 'm1', sources: { modelId: 'global' } }),
      availableModels: ref([]),
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
      chatFlow: ref([]),
      isThinkingActive: vi.fn(() => false),
      isWaitingResponse: vi.fn(() => false),
    } as any);

    const wrapper = mountChatPane( {
      global: {
        plugins: [router],
        stubs: {
          MessageItem: true,
          ChatSettingsPanel: true,
          WelcomeScreen: true,
          ModelSelector: true,
        },
      },
    });

    await nextTick();

    const textarea = wrapper.find('[data-testid="chat-input"]');
    await textarea.setValue('Hello from Chat B');

    const sendButton = wrapper.find('[data-testid="send-button"]');
    expect(sendButton.exists()).toBe(true);

    await sendButton.trigger('click');

    // Expectation that will fail if bug exists
    expect(mockSendMessage).toHaveBeenCalledWith({ content: 'Hello from Chat B', parentId: undefined, attachments: [], chatTarget: undefined, lmParameters: expect.anything() });
  });
});
