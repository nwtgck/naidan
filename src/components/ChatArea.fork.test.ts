import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { ref } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { asyncComponentTracker } from '../utils/async-component-test-utils';

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();
  const { wrapVueWithAsyncTracking } = await vi.importActual<any>('../utils/async-component-test-utils');
  return wrapVueWithAsyncTracking(actual);
});

// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }, { path: '/chat/:id', component: {} }],
});

// Mock dependencies
const mockForkChat = vi.fn();
const mockCurrentChat = ref<{
  id: string;
  title: string;
  root: any;
  currentLeafId: string | undefined;
  debugEnabled: boolean;
  originChatId: string | undefined;
  modelId: string | undefined;
}>({
  id: '1', 
  title: 'Test Chat', 
  root: { items: [] },
  currentLeafId: undefined,
  debugEnabled: false, 
  originChatId: undefined,
  modelId: undefined,
});
const mockActiveMessages = ref<any[]>([]);

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
    chatGroups: ref([]),
    resolvedSettings: ref({ modelId: 'm1', sources: { modelId: 'global' } }),
    inheritedSettings: ref({ modelId: 'm1', sources: { modelId: 'global' } }),
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
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointType: 'openai', endpointUrl: 'http://localhost', defaultModelId: 'global-default-model' }),
  }),
}));

describe('ChatArea Fork Functionality', () => {
  afterAll(async () => {
    await asyncComponentTracker.wait();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveMessages.value = [];
    mockCurrentChat.value.originChatId = undefined;
  });

  it('should not show fork button when there are no messages', async () => {
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    expect(wrapper.find('[data-testid="fork-chat-button"]').exists()).toBe(false);
  });

  it('should show fork button when there are messages', async () => {
    mockActiveMessages.value = [{ id: 'msg-1', role: 'user', content: 'hello' }];
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    expect(wrapper.find('[data-testid="fork-chat-button"]').exists()).toBe(true);
  });

  it('should call forkChat with the last message ID when fork button is clicked', async () => {
    mockActiveMessages.value = [
      { id: 'msg-1', role: 'user', content: 'hello' },
      { id: 'msg-2', role: 'assistant', content: 'hi' }
    ];
    mockForkChat.mockResolvedValue('new-chat-id');
    
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const forkBtn = wrapper.find('[data-testid="fork-chat-button"]');
    await forkBtn.trigger('click');
    
    expect(mockForkChat).toHaveBeenCalledWith('msg-2');
  });

  it('should change jump-to-origin button icon to ArrowUp', async () => {
    mockCurrentChat.value.originChatId = 'parent-id';
    const wrapper = mount(ChatArea, {
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