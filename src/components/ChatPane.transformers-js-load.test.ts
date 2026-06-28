import type { ChatId, MessageId } from '@/models/ids';
import { toChatId } from '@/models/ids';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, VueWrapper } from '@vue/test-utils';
import ChatPane from './ChatPane.vue';
import { nextTick, ref, computed } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { transformersJsService } from '@/services/transformers-js';
import { setupScrollToMock } from '@/utils/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';

// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }],
});

// Mock transformersJsService

vi.mock('@/composables/useApplicationPresentation', () => ({
  isApplicationInteractionEnabled: ({ interaction }: { interaction: string }) => interaction === 'enabled',
  useApplicationPresentation: () => ({
    applicationInteraction: {
      __v_isRef: true,
      value: 'enabled',
    },
  }),
}));

vi.mock('../services/transformers-js', () => {
  const state = {
    status: 'idle',
    progress: 0,
    error: undefined,
    isLoadingFromCache: false,
    loadingModelId: undefined,
    activeModelId: undefined,
    device: 'wasm',
    isCached: false,
    progressItems: new Map(),
    totalLoadedAmount: 0,
    totalSizeAmount: 0,
  };
  const listeners = new Set();
  return {
    transformersJsService: {
      getState: vi.fn(() => state),
      subscribe: vi.fn(({ listener }) => {
        listeners.add(listener);
        listener({
          status: state.status,
          progress: state.progress,
          error: state.error,
          isCached: state.isCached,
          isLoadingFromCache: state.isLoadingFromCache,
          progressItems: state.progressItems,
          loadingModelId: state.loadingModelId,
        });
        return () => listeners.delete(listener);
      }),
      // Helper for testing to trigger state changes
      __triggerStateChange: (updates: any) => {
        Object.assign(state, updates);
        listeners.forEach((listener: any) => listener({
          status: state.status,
          progress: state.progress,
          error: state.error,
          isCached: state.isCached,
          isLoadingFromCache: state.isLoadingFromCache,
          progressItems: state.progressItems,
          loadingModelId: state.loadingModelId,
        }));
      },
    },
  };
});

// Mock dependencies
const mockCurrentChat = ref<any>({
  id: toChatId({ raw: '1' }),
  title: 'Test Chat',
  root: { items: [] },
  currentLeafId: 'msg-2',
  debugEnabled: false,
  endpointType: 'transformers_js',
});
const mockActiveMessages = ref<any[]>([]);
const mockResolvedSettings = ref<any>({
  endpointType: 'transformers_js',
  modelId: 'm',
  sources: { modelId: 'global' },
});
const mockInheritedSettings = ref<any>({ modelId: 'm', sources: { modelId: 'global' } });
const mockChatGroups = ref<any[]>([]);
const mockFetchingModels = ref(false);
const mockAvailableModels = ref<string[]>([]);
const mockIsProcessing = ref(true);

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: ref(null),
    chatGroups: mockChatGroups,
    resolvedSettings: mockResolvedSettings,
    inheritedSettings: mockInheritedSettings,
    availableModels: ref([]),
    activeMessages: mockActiveMessages,
    getSiblings: vi.fn().mockReturnValue([]),
    getSortedImageModels: vi.fn(() => []),
    abortChat: vi.fn(),
    isImageMode: vi.fn(() => false),
    toggleImageMode: vi.fn(),
    getResolution: vi.fn(() => ({ width: 512, height: 512 })),
    updateResolution: vi.fn(),
    getCount: vi.fn(() => 1),
    updateCount: vi.fn(),
    getSteps: vi.fn(() => undefined),
    updateSteps: vi.fn(),
    getSeed: vi.fn(() => 'browser_random'),
    updateSeed: vi.fn(),
    getPersistAs: vi.fn(() => 'original'),
    updatePersistAs: vi.fn(),
    setImageModel: vi.fn(),
    getSelectedImageModel: vi.fn(),
    generateChatTitle: vi.fn(),
    abortTitleGeneration: vi.fn(),
    generatingTitle: ref(false),
    fetchAvailableModels: vi.fn(),
    fetchingModels: ref(false),
    getReasoningEffort: vi.fn(),
    updateReasoningEffort: vi.fn(),
    updateChatSettings: vi.fn(),
    getLiveChat: vi.fn().mockImplementation((c) => c),
    chatFlow: computed(() => mockActiveMessages.value.map(m => ({
      type: 'message',
      node: m,
      mode: m.role === 'assistant' && !m.content ? 'waiting' : 'content',
      flow: { position: 'standalone', nesting: 'none' },
      isFirstInNode: true,
      isLastInNode: true,
      isFirstInTurn: true,
    }))),
    isThinkingActive: vi.fn(() => false),
    isWaitingResponse: vi.fn(({ item }) => item.type === 'message' && item.mode === 'waiting'),
  }),
}));

vi.mock('../composables/chat/chat-activity-queries', () => ({
  isChatProcessing: () => mockIsProcessing.value,
  isChatTaskRunning: () => mockIsProcessing.value,
  getChatContextCompactProgress: () => ({ phase: 'idle' }),
  isChatGeneratingTitle: () => false,
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
      mode: m.role === 'assistant' && !m.content ? 'waiting' : 'content',
      flow: { position: 'standalone', nesting: 'none' },
      isFirstInNode: true,
      isLastInNode: true,
      isFirstInTurn: true,
    }))),
    isThinkingActive: vi.fn(() => false),
    isWaitingResponse: vi.fn(({ item }: { item: { type: string, mode?: string } }) => item.type === 'message' && item.mode === 'waiting'),
  }),
}));

vi.mock('../composables/chat/useChatConversation', () => ({
  useChatConversation: () => ({
    sendMessage: vi.fn().mockResolvedValue(true),
    regenerateMessage: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatModels', () => ({
  useChatModels: () => ({
    availableModels: mockAvailableModels,
    fetchingModels: computed(() => mockFetchingModels.value),
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
    sendMessage: vi.fn().mockResolvedValue(true),
    regenerateMessage: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatModelSelection', () => ({
  useChatModelSelection: () => ({
    availableModels: mockAvailableModels,
    fetchingModels: computed(() => mockFetchingModels.value),
    fetchModels: vi.fn().mockResolvedValue([]),
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

vi.mock('../composables/useChatWeshTerminalSessions', () => ({
  buildWorkerMountsForChat: vi.fn().mockResolvedValue([]),
  useChatWeshTerminalSessions: vi.fn(() => ({
    createChatWorkerSession: vi.fn(),
    ensureActiveSession: vi.fn(),
    reopenSessionIfNeeded: vi.fn(),
    closeSession: vi.fn(),
    closeAllSessions: vi.fn(),
    sessions: ref([]),
    activeSessionId: ref(undefined),
  })),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointType: 'transformers_js' }),
    availableModels: mockAvailableModels,
  }),
}));

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), run: vi.fn() },
}));

describe('Transformers.js Loading Flow in ChatPane', () => {
  let wrapper: VueWrapper<any>;

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    setupScrollToMock();
    vi.clearAllMocks();
    mockActiveMessages.value = [
      { id: 'msg-1', role: 'user', content: 'hello', timestamp: Date.now(), replies: { items: [] } },
      { id: 'msg-2', role: 'assistant', content: '', timestamp: Date.now(), modelId: 'hf.co/model', replies: { items: [] } },
    ];
    mockCurrentChat.value.currentLeafId = 'msg-2';
    (transformersJsService as any).__triggerStateChange({ status: 'idle', progress: 0 });
  });

  afterEach(() => {
    if (wrapper) wrapper.unmount();
  });

  it('hides assistant message and shows loading indicator when engine is loading', async () => {
    // 1. Simulate engine loading
    (transformersJsService as any).__triggerStateChange({
      status: 'loading',
      progress: 45,
      loadingModelId: 'hf.co/SmolLM2',
    });

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await nextTick();

    // Verify Loading Indicator is rendering content
    const loader = wrapper.findComponent({ name: 'TransformersJsLoadingIndicator' });
    expect(loader.exists()).toBe(true);
    // Indicator has internal v-if, so we check if it rendered the outer div
    expect(loader.find('div').exists()).toBe(true);
    expect(loader.text()).toContain('45%');
    expect(loader.text()).toContain('SmolLM2');

    // Verify Assistant MessageItem root is not rendered while loading.
    expect(wrapper.find('#message-msg-2').exists()).toBe(false);

    // User message should still be visible.
    expect(wrapper.find('#message-msg-1').exists()).toBe(true);
  });

  it('shows assistant message and hides loading indicator when engine becomes ready', async () => {
    // 1. Start with loading state
    (transformersJsService as any).__triggerStateChange({ status: 'loading', progress: 99 });

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await nextTick();
    expect(wrapper.findComponent({ name: 'TransformersJsLoadingIndicator' }).find('div').exists()).toBe(true);

    // 2. Transition to ready
    (transformersJsService as any).__triggerStateChange({ status: 'ready', progress: 100 });

    await nextTick();
    await nextTick(); // Extra tick for reactivity

    // Verify Loading Indicator inner content is GONE
    expect(wrapper.findComponent({ name: 'TransformersJsLoadingIndicator' }).find('div').exists()).toBe(false);

    // Verify Assistant MessageItem inner content is now RENDERED
    const messageItems = wrapper.findAllComponents({ name: 'MessageItem' });
    const assistantItem = messageItems.find(m => m.props('message').role === 'assistant');
    expect(assistantItem?.find('div').exists()).toBe(true);
    await vi.waitFor(() => {
      const updatedAssistantItem = wrapper
        .findAllComponents({ name: 'MessageItem' })
        .find(m => m.props('message').role === 'assistant');
      expect(updatedAssistantItem?.text()).toContain('Waiting for response...');
    }, { timeout: 5000 });
  });

  it('shows assistant message immediately if engine is already ready', async () => {
    // 1. Engine already ready
    (transformersJsService as any).__triggerStateChange({ status: 'ready', progress: 100 });

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await nextTick();

    // Loading Indicator inner content should NOT exist
    expect(wrapper.findComponent({ name: 'TransformersJsLoadingIndicator' }).find('div').exists()).toBe(false);

    // Assistant item should EXIST immediately
    const messageItems = wrapper.findAllComponents({ name: 'MessageItem' });
    const assistantItem = messageItems.find(m => m.props('message').role === 'assistant');
    expect(assistantItem?.find('div').exists()).toBe(true);
  });

  it('shows assistant message immediately for non-transformers_js endpoints even if engine is loading something else', async () => {
    // 1. Simulate engine loading (maybe background task)
    (transformersJsService as any).__triggerStateChange({ status: 'loading', progress: 50 });

    // 2. Set endpoint to OpenAI
    mockResolvedSettings.value = {
      endpointType: 'openai',
      modelId: 'gpt-4o',
      sources: { modelId: 'global' },
    };

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await nextTick();

    // The assistant message should NOT be hidden in MessageItem.
    const messageItems = wrapper.findAllComponents({ name: 'MessageItem' });
    const assistantItem = messageItems.find(m => m.props('message').role === 'assistant');
    expect(assistantItem?.find('div').exists()).toBe(true); // Should NOT be hidden because it's OpenAI
  });
});
