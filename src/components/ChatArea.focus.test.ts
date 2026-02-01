import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mount, VueWrapper } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { ref, nextTick } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import type { MessageNode, Chat } from '../models/types';
import { asyncComponentTracker } from '../utils/async-component-test-utils';

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();
  const { wrapVueWithAsyncTracking } = await vi.importActual<any>('../utils/async-component-test-utils');
  return wrapVueWithAsyncTracking(actual);
});

// Mock dependencies
const mockCurrentChat = ref<Chat | null>({
  id: '1', 
  title: 'Test Chat', 
  root: { items: [] } as { items: MessageNode[] },
  currentLeafId: undefined,
  debugEnabled: false, 
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const mockActiveFocusArea = ref('chat');
const mockSetActiveFocusArea = vi.fn((area) => {
  mockActiveFocusArea.value = area; 
});

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    activeFocusArea: mockActiveFocusArea,
    setActiveFocusArea: mockSetActiveFocusArea,
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    streaming: ref(false),
    activeMessages: ref([]),
    isProcessing: vi.fn().mockReturnValue(false),
    fetchAvailableModels: vi.fn(),
    getSiblings: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({}),
    availableModels: ref([]),
    isFetchingModels: ref(false),
  }),
}));

describe('ChatArea Focus Specifications', () => {
  afterAll(async () => {
    await asyncComponentTracker.wait();
  });

  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  let wrapper: VueWrapper<any> | null = null;

  beforeEach(() => {
    mockActiveFocusArea.value = 'chat';
    mockSetActiveFocusArea.mockClear();
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('sets focus area to chat when the container is clicked', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });
    
    // Click the main container
    await wrapper.trigger('click');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith('chat');
  });

  it('sets focus area to chat when the textarea is focused', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });
    
    const textarea = wrapper.find('[data-testid="chat-input"]');
    await textarea.trigger('focus');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith('chat');
  });

  it('prevents automatic focus on textarea when focus area is sidebar', async () => {
    mockActiveFocusArea.value = 'sidebar';
    
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });
    
    const textarea = wrapper.find('[data-testid="chat-input"]').element as HTMLTextAreaElement;
    
    // Switch chat while focused on sidebar
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: '2' };
    await nextTick();
    await nextTick();
    
    expect(document.activeElement).not.toBe(textarea);
  });

  it('automatically focuses textarea when a new chat is created and area is chat', async () => {
    mockActiveFocusArea.value = 'chat';
    
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });
    
    const textarea = wrapper.find('[data-testid="chat-input"]').element as HTMLTextAreaElement;
    
    // Simulate new chat creation
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: 'new-chat-id' };
    await nextTick();
    await nextTick();
    
    expect(document.activeElement).toBe(textarea);
  });

  it('focuses textarea when a grouped chat is created even if starting from sidebar focus', async () => {
    // 1. Start with sidebar focus (e.g. user clicked sidebar or a group)
    mockActiveFocusArea.value = 'sidebar';
    
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router], stubs: { 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true, 'Logo': true, 'ModelSelector': true, 'lucide-vue-next': true } },
    });
    
    const textarea = wrapper.find('[data-testid="chat-input"]').element as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(textarea);

    // 2. Simulate handleNewChat setting area to 'chat' before store update
    mockActiveFocusArea.value = 'chat';
    
    // 3. Simulate store update (new chat ID set)
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: 'grouped-chat-id' };
    await nextTick();
    await nextTick();
    
    // 4. Should be focused now
    expect(document.activeElement).toBe(textarea);
  });
});
