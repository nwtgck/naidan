import type { ChatId, MessageId } from '@/models/ids';
import { toMessageId, toChatId } from '@/models/ids';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatPane from './ChatPane.vue';
import { ref, computed } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';


import { setupScrollToMock } from '@/utils/test-utils';


// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }, { path: '/chat/:id', component: {} }],
});

// Mock dependencies
const mockForkChat = vi.fn();
const mockCurrentChat = ref<{
  id: ChatId,
  title: string,
  root: any,
  currentLeafId: MessageId | undefined,
  debugEnabled: boolean,
  originChatId: string | undefined,
  modelId: string | undefined,
}>({
  id: toChatId({ raw: '1' }),
  title: 'Test Chat',
  root: { items: [] },
  currentLeafId: undefined,
  debugEnabled: false,
  originChatId: undefined,
  modelId: undefined,
});
const mockActiveMessages = ref<any[]>([]);
const mockChatGroups = ref<any[]>([]);
const mockResolvedSettings = ref<any>({ modelId: 'm1', sources: { modelId: 'global' } });
const mockInheritedSettings = ref<any>({ modelId: 'm1', sources: { modelId: 'global' } });

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    sendMessage: vi.fn(),
    streaming: ref(false),
    activeGenerations: new Map(),
    toggleDebug: vi.fn(),
    activeMessages: mockActiveMessages,
    getSiblings: vi.fn().mockReturnValue([]),
    editMessage: vi.fn(),
    switchVersion: vi.fn(),
    abortChat: vi.fn(),
    availableModels: ref([]),
    fetchingModels: ref(false),
    generatingTitle: ref(false),
    generateChatTitle: vi.fn(),
    abortTitleGeneration: vi.fn(),
    chatGroups: mockChatGroups,
    resolvedSettings: mockResolvedSettings,
    inheritedSettings: mockInheritedSettings,
    fetchAvailableModels: vi.fn(),
    updateChatModel: vi.fn(),
    forkChat: mockForkChat,
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    isImageMode: vi.fn(() => false),
    toggleImageMode: vi.fn(),
    getResolution: vi.fn(() => ({ width: 512, height: 512 })),
    getCount: vi.fn(() => 1),
    updateCount: vi.fn(),
    getSteps: vi.fn(() => undefined),
    updateSteps: vi.fn(),
    getSeed: vi.fn(() => 'browser_random'),
    updateSeed: vi.fn(),
    getPersistAs: vi.fn(() => 'original'),
    updatePersistAs: vi.fn(),
    updateResolution: vi.fn(),
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

vi.mock('../composables/useChatDisplayFlow', () => ({
  useChatDisplayFlow: () => ({
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

vi.mock('../composables/chat/useChatConversation', () => ({
  useChatConversation: () => ({
    sendMessage: vi.fn().mockResolvedValue(true),
    regenerateMessage: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatBranches', () => ({
  useChatBranches: () => ({
    editMessage: vi.fn(),
    switchVersion: vi.fn(),
    forkChat: ({ messageId }: { chatId: string, messageId: string }) => mockForkChat({ messageId }),
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
    toggleDebug: vi.fn(),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatHistory', () => ({
  useChatHistory: () => ({
    editMessage: vi.fn(),
    switchVersion: vi.fn(),
    forkChat: ({ messageId }: { messageId: string }) => mockForkChat({ messageId }),
    getSiblings: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatGeneration', () => ({
  useChatGeneration: () => ({
    sendMessage: vi.fn().mockResolvedValue(true),
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
    settings: ref({ endpointType: 'openai', endpointUrl: 'http://localhost', defaultModelId: 'global-default-model' }),
  }),
}));

describe('ChatPane Fork Functionality', () => {
  beforeEach(() => {
    setupScrollToMock();
    vi.clearAllMocks();
    mockActiveMessages.value = [];
    mockCurrentChat.value.originChatId = undefined;
  });

  it('should not show fork button when there are no messages', async () => {
    const wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    expect(wrapper.find('[data-testid="fork-chat-button"]').exists()).toBe(false);
  });

  it('should show fork button when there are messages', async () => {
    mockActiveMessages.value = [{ id: 'msg-1', role: 'user', content: 'hello' }];
    const wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    expect(wrapper.find('[data-testid="fork-chat-button"]').exists()).toBe(true);
  });

  it('should call forkChat with the last message ID when fork button is clicked', async () => {
    mockActiveMessages.value = [
      { id: 'msg-1', role: 'user', content: 'hello' },
      { id: 'msg-2', role: 'assistant', content: 'hi' },
    ];
    mockForkChat.mockResolvedValue('new-chat-id');

    const wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const forkBtn = wrapper.find('[data-testid="fork-chat-button"]');
    await forkBtn.trigger('click');

    expect(mockForkChat).toHaveBeenCalledWith({ messageId: toMessageId({ raw: 'msg-2' }) });
  });

  it('should change jump-to-origin button icon to ArrowUp', async () => {
    mockCurrentChat.value.originChatId = 'parent-id';
    const wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const jumpBtn = wrapper.find('[data-testid="jump-to-origin-button"]');
    expect(jumpBtn.exists()).toBe(true);

    // In lucide-vue-next, icons are rendered as SVG.
    // We can check if it contains the ArrowUp component or class if it was stubbed,
    // but since we're using full mount, we'll check for the icon component or title.
    // Lucide icons usually have a class like 'lucide-arrow-up'
    expect(jumpBtn.find('.lucide-arrow-up').exists()).toBe(true);
    expect(jumpBtn.find('.lucide-git-fork').exists()).toBe(false);
  });
});
