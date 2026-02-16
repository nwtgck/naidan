
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, VueWrapper } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { nextTick, ref } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { transformersJsService } from '../services/transformers-js';

// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }],
});

// Mock transformersJsService
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
    progressItems: {},
    totalLoadedAmount: 0,
    totalSizeAmount: 0
  };
  const listeners = new Set();
  return {
    transformersJsService: {
      getState: vi.fn(() => state),
      subscribe: vi.fn((cb) => {
        listeners.add(cb);
        cb(state.status, state.progress, state.error, state.isCached, state.isLoadingFromCache, state.progressItems, state.loadingModelId);
        return () => listeners.delete(cb);
      }),
      // Helper for testing to trigger state changes
      __triggerStateChange: (updates: any) => {
        Object.assign(state, updates);
        listeners.forEach((cb: any) => cb(state.status, state.progress, state.error, state.isCached, state.isLoadingFromCache, state.progressItems, state.loadingModelId));
      }
    }
  };
});

// Mock dependencies
const mockCurrentChat = ref<any>({
  id: '1',
  title: 'Test Chat',
  root: { items: [] },
  currentLeafId: 'msg-2',
  debugEnabled: false,
  endpointType: 'transformers_js'
});
const mockActiveMessages = ref<any[]>([]);
const mockResolvedSettings = ref<any>({
  endpointType: 'transformers_js',
  modelId: 'm',
  sources: { modelId: 'global' }
});

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: ref(null),
    chatGroups: ref([]),
    resolvedSettings: mockResolvedSettings,
    inheritedSettings: ref({ modelId: 'm', sources: { modelId: 'global' } }),
    availableModels: ref([]),
    isProcessing: vi.fn(() => true),
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
    fetchAvailableModels: vi.fn(),
    fetchingModels: ref(false),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointType: 'transformers_js' }),
    availableModels: ref([]),
  }),
}));

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), run: vi.fn() }
}));

describe('Transformers.js Loading Flow in ChatArea', () => {
  let wrapper: VueWrapper<any>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockActiveMessages.value = [
      { id: 'msg-1', role: 'user', content: 'hello', timestamp: Date.now(), replies: { items: [] } },
      { id: 'msg-2', role: 'assistant', content: '', timestamp: Date.now(), modelId: 'hf.co/model', replies: { items: [] } }
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
      loadingModelId: 'hf.co/SmolLM2'
    });

    wrapper = mount(ChatArea, {
      global: { plugins: [router] }
    });

    await nextTick();

    // Verify Loading Indicator is rendering content
    const loader = wrapper.findComponent({ name: 'TransformersJsLoadingIndicator' });
    expect(loader.exists()).toBe(true);
    // Indicator has internal v-if, so we check if it rendered the outer div
    expect(loader.find('div').exists()).toBe(true);
    expect(loader.text()).toContain('45%');
    expect(loader.text()).toContain('SmolLM2');

    // Verify Assistant MessageItem is NOT rendered (it should be <!--v-if-->)
    const messageItems = wrapper.findAllComponents({ name: 'MessageItem' });
    const assistantItem = messageItems.find(m => m.props('message').role === 'assistant');
    // In vue-test-utils, if v-if is on the root element, the component wrapper might still exist
    // but its html() will be empty or <!--v-if-->
    expect(assistantItem?.find('div').exists()).toBe(false);

    // User message should still be visible
    const userItem = messageItems.find(m => m.props('message').role === 'user');
    expect(userItem?.find('div').exists()).toBe(true);
  });

  it('shows assistant message and hides loading indicator when engine becomes ready', async () => {
    // 1. Start with loading state
    (transformersJsService as any).__triggerStateChange({ status: 'loading', progress: 99 });

    wrapper = mount(ChatArea, {
      global: { plugins: [router] }
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
    expect(assistantItem?.text()).toContain('Waiting for response...');
  });

  it('shows assistant message immediately if engine is already ready', async () => {
    // 1. Engine already ready
    (transformersJsService as any).__triggerStateChange({ status: 'ready', progress: 100 });

    wrapper = mount(ChatArea, {
      global: { plugins: [router] }
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
      sources: { modelId: 'global' }
    };

    wrapper = mount(ChatArea, {
      global: { plugins: [router] }
    });

    await nextTick();

    // The assistant message should NOT be hidden in MessageItem.
    const messageItems = wrapper.findAllComponents({ name: 'MessageItem' });
    const assistantItem = messageItems.find(m => m.props('message').role === 'assistant');
    expect(assistantItem?.find('div').exists()).toBe(true); // Should NOT be hidden because it's OpenAI
  });
});
