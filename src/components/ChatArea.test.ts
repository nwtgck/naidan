import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { nextTick, ref } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }],
});

import type { MessageNode } from '../models/types';

// Mock dependencies
const mockSendMessage = vi.fn();
const mockAbortChat = vi.fn();
const mockStreaming = ref(false);
const mockCurrentChat = ref({ 
  id: '1', 
  title: 'Test Chat', 
  root: { items: [] } as { items: MessageNode[] },
  currentLeafId: undefined as string | undefined,
  debugEnabled: false, 
});
const mockActiveMessages = ref<MessageNode[]>([]);

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    sendMessage: mockSendMessage,
    streaming: mockStreaming,
    toggleDebug: vi.fn(),
    activeMessages: mockActiveMessages,
    getSiblings: vi.fn().mockReturnValue([]),
    editMessage: vi.fn(),
    switchVersion: vi.fn(),
    abortChat: mockAbortChat,
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost' } },
  }),
}));

interface ChatAreaExposed {
  scrollToBottom: () => void;
  container: HTMLElement | null;
  handleSend: () => Promise<void>;
}

describe('ChatArea UI States', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStreaming.value = false;
    mockActiveMessages.value = [];
    document.body.innerHTML = '<div id="app"></div>';
  });

  it('should keep the input textarea enabled during streaming', async () => {
    mockStreaming.value = true;
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect((textarea.element as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('should show the abort button and hide the send button during streaming', async () => {
    mockStreaming.value = true;
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const abortBtn = wrapper.find('[data-testid="abort-button"]');
    expect(abortBtn.exists()).toBe(true);
    expect(abortBtn.text()).toContain('Esc');
    expect(wrapper.find('[data-testid="send-button"]').exists()).toBe(false);
  });

  it('should call abortChat when Esc is pressed during streaming', async () => {
    mockStreaming.value = true;
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const textarea = wrapper.find('[data-testid="chat-input"]');
    await textarea.trigger('keydown.esc');
    expect(mockAbortChat).toHaveBeenCalled();
  });

  it('should show the send button with shortcut text when not streaming', async () => {
    mockStreaming.value = false;
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const sendBtn = wrapper.find('[data-testid="send-button"]');
    expect(sendBtn.exists()).toBe(true);
    // Shortcut text depends on OS, but should contain either 'Enter' or 'Cmd'/'Ctrl'
    expect(sendBtn.text()).toMatch(/(Enter|Cmd|Ctrl)/);
  });

  it('should show the chat inspector when debug mode is enabled', async () => {
    mockCurrentChat.value.debugEnabled = true;
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const inspector = wrapper.find('[data-testid="chat-inspector"]');
    expect(inspector.exists()).toBe(true);
    expect(inspector.text()).toContain('Metadata');
  });

  it('should hide the chat inspector when debug mode is disabled', async () => {
    mockCurrentChat.value.debugEnabled = false;
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    expect(wrapper.find('[data-testid="chat-inspector"]').exists()).toBe(false);
  });
});

describe('ChatArea Scrolling Logic', () => {
  let scrollSetterSpy: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStreaming.value = false;
    mockActiveMessages.value = [];
    document.body.innerHTML = '';
    scrollSetterSpy = vi.fn();
  });

  function setupScrollMock(element: HTMLElement) {
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 500 });
    
    let internalScrollTop = 0;
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => internalScrollTop,
      set: (val) => {
        internalScrollTop = val;
        scrollSetterSpy(val);
      },
    });
  }

  it('should scroll to bottom when a new message is added', async () => {
    const wrapper = mount(ChatArea, { 
      attachTo: document.body,
      global: { plugins: [router] }, 
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);
    
    // Clear initial mount-time scrolls
    await flushPromises();
    await nextTick();
    scrollSetterSpy.mockClear();

    mockActiveMessages.value = [{ id: '1', role: 'user', content: 'hello', timestamp: Date.now(), replies: { items: [] } }];
    
    await flushPromises();
    await nextTick();
    await nextTick();

    expect(scrollSetterSpy).toHaveBeenCalledWith(1000);
    wrapper.unmount();
  });

  it('should scroll during streaming if user is at the bottom', async () => {
    mockActiveMessages.value = [{ id: '1', role: 'assistant', content: '', timestamp: Date.now(), replies: { items: [] } }];
    
    const wrapper = mount(ChatArea, { 
      attachTo: document.body,
      global: { plugins: [router] }, 
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);
    
    // Settle mount-time scrolls
    await flushPromises();
    await nextTick();
    
    // Set at bottom
    container.scrollTop = 500; 
    scrollSetterSpy.mockClear();

    mockStreaming.value = true;
    mockActiveMessages.value[0]!.content = 'Thinking...';
    
    await flushPromises();
    await nextTick();
    await nextTick();
    
    expect(scrollSetterSpy).toHaveBeenCalledWith(1000);
    wrapper.unmount();
  });

  it('should NOT scroll during streaming if user has scrolled up', async () => {
    mockActiveMessages.value = [{ id: '1', role: 'assistant', content: '', timestamp: Date.now(), replies: { items: [] } }];
    
    const wrapper = mount(ChatArea, { 
      attachTo: document.body,
      global: { plugins: [router] }, 
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);
    
    // Settle mount-time scrolls
    await flushPromises();
    await nextTick();
    
    // Set scrolled up (not at bottom)
    container.scrollTop = 100; 
    scrollSetterSpy.mockClear();

    mockStreaming.value = true;
    mockActiveMessages.value[0]!.content = 'Thinking...';
    
    await flushPromises();
    await nextTick();
    await nextTick();
    
    expect(scrollSetterSpy).not.toHaveBeenCalledWith(1000);
    expect(container.scrollTop).toBe(100);
    wrapper.unmount();
  });

  it('should stop scrolling after content exceeds 400 characters', async () => {
    mockActiveMessages.value = [{ id: '1', role: 'assistant', content: 'A'.repeat(400), timestamp: Date.now(), replies: { items: [] } }];
    
    const wrapper = mount(ChatArea, { 
      attachTo: document.body,
      global: { plugins: [router] }, 
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);
    
    // Settle mount-time scrolls
    await flushPromises();
    await nextTick();
    
    container.scrollTop = 500; // at bottom
    scrollSetterSpy.mockClear();

    mockStreaming.value = true;
    mockActiveMessages.value[0]!.content += ' exceeded';
    
    await flushPromises();
    await nextTick();
    await nextTick();
    
    expect(scrollSetterSpy).not.toHaveBeenCalledWith(1000);
    expect(container.scrollTop).toBe(500);
    wrapper.unmount();
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
        plugins: [router],
      },
    });
    
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    
    // Manually trigger the send logic to verify focus behavior
    // We already tested UI states separately
    await (wrapper.vm as unknown as ChatAreaExposed).handleSend();
    
    // Wait for focusInput nextTick
    await nextTick();
    await nextTick();
    
    expect(document.activeElement).toBe(textarea.element);
  });

  it('should focus the textarea when chat is opened', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: {
        plugins: [router],
      },
    });
    
    await nextTick();
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect(document.activeElement).toBe(textarea.element);
  });
});