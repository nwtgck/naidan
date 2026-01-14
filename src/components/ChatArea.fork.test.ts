import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { ref } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

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
  overrideModelId: string | undefined;
}>({
  id: '1', 
  title: 'Test Chat', 
  root: { items: [] },
  currentLeafId: undefined,
  debugEnabled: false, 
  originChatId: undefined,
  overrideModelId: undefined,
});
const mockActiveMessages = ref<any[]>([]);

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    sendMessage: vi.fn(),
    streaming: ref(false),
    toggleDebug: vi.fn(),
    activeMessages: mockActiveMessages,
    getSiblings: vi.fn().mockReturnValue([]),
    editMessage: vi.fn(),
    switchVersion: vi.fn(),
    abortChat: vi.fn(),
    availableModels: ref([]),
    fetchingModels: ref(false),
    fetchAvailableModels: vi.fn(),
    forkChat: mockForkChat,
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointType: 'openai', endpointUrl: 'http://localhost', defaultModelId: 'global-default-model' }),
  }),
}));

describe('ChatArea Fork Functionality', () => {
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
