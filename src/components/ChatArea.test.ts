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

import type { MessageNode } from '../models/types';

// Mock dependencies
const mockSendMessage = vi.fn();
const mockStreaming = ref(false);
const mockCurrentChat = ref({ 
  id: '1', 
  title: 'Test Chat', 
  root: { items: [] } as { items: MessageNode[] },
  currentLeafId: undefined as string | undefined,
  debugEnabled: false 
});

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    sendMessage: mockSendMessage,
    streaming: mockStreaming,
    toggleDebug: vi.fn(),
    activeMessages: ref([] as MessageNode[]),
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

describe('ChatArea UI States', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStreaming.value = false;
    document.body.innerHTML = '<div id="app"></div>';
  });

  it('should keep the input textarea enabled during streaming', async () => {
    mockStreaming.value = true;
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] }
    });
    
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect((textarea.element as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('should disable the send button during streaming', async () => {
    mockStreaming.value = true;
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] }
    });
    
    // Find the send button by its title or finding the button with the Send icon
    const sendButton = wrapper.find('button[title*="Send message"]');
    expect((sendButton.element as HTMLButtonElement).disabled).toBe(true);
  });
});

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
    
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    
    // Manually trigger the send logic to verify focus behavior
    // We already tested UI states separately
    await (wrapper.vm as unknown as { handleSend: () => Promise<void> }).handleSend();
    
    // Wait for focusInput nextTick
    await nextTick();
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
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect(document.activeElement).toBe(textarea.element);
  });
});
