import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { nextTick, ref } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }]
});

// Mock dependencies
const mockSendMessage = vi.fn();
const mockCurrentChat = ref({ 
  id: '1', 
  title: 'Test Chat', 
  root: null as any,
  currentLeafId: undefined,
  debugEnabled: false 
});

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    sendMessage: mockSendMessage,
    streaming: ref(false),
    toggleDebug: vi.fn(),
    activeMessages: ref([] as any[]),
    getSiblings: vi.fn().mockReturnValue([]),
    editMessage: vi.fn(),
    switchVersion: vi.fn()
  })
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost' } }
  })
}));

describe('ChatArea Focus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="app"></div>';
  });

  it('should focus the textarea after sending a message', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: {
        plugins: [router]
      }
    });
    
    const textarea = wrapper.find('textarea');
    await textarea.setValue('Hello');
    
    // Simulate send (Ctrl+Enter)
    await textarea.trigger('keydown.enter', { ctrlKey: true });
    
    expect(mockSendMessage).toHaveBeenCalledWith('Hello');
    
    // Wait for nextTick used in focusInput
    await nextTick();
    
    expect(document.activeElement).toBe(textarea.element);
  });

  it('should focus the textarea when chat is opened', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: {
        plugins: [router]
      }
    });
    
    await nextTick();
    const textarea = wrapper.find('textarea');
    expect(document.activeElement).toBe(textarea.element);
  });
});
