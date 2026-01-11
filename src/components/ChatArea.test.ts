import { describe, it, expect, vi, beforeEach, type Mock, beforeAll } from 'vitest';
import { mount, shallowMount, flushPromises } from '@vue/test-utils';
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

describe('ChatArea Export Functionality', () => {
  // Mock browser APIs for file download
  const mockCreateObjectURL: typeof URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      type MockBlobWithText = Blob & { text?: Mock };
      let _storedBlob: MockBlobWithText | null = null;
      if (blob instanceof Blob) {
        _storedBlob = blob as MockBlobWithText;
        // Add the mock text() method to the *storedBlob* (which is a Blob)
        _storedBlob.text = vi.fn(async () => {
          const reader = new FileReader();
          return new Promise<string>((resolve, reject) => {
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(_storedBlob!);
          });
        }) as Mock;
      }
      return 'blob:mockurl';
  });
  const mockRevokeObjectURL = vi.fn();
  const mockAnchorClick = vi.fn();
  const mockAppendChild = vi.fn();
  const mockRemoveChild = vi.fn();
  let originalCreateElement: (tagName: string, options?: ElementCreationOptions) => HTMLElement;
        
  beforeAll(() => {
    // Capture the original createElement once, before any mocks are applied
    originalCreateElement = global.document.createElement;
  });
        
  beforeEach(() => {
    vi.clearAllMocks();
    mockStreaming.value = false;
    mockActiveMessages.value = [];
    mockCurrentChat.value = { 
      id: '1', 
      title: 'Test Chat', 
      root: { items: [] } as { items: MessageNode[] },
      currentLeafId: undefined,
      debugEnabled: false, 
    };
    document.body.innerHTML = '<div id="app"></div>';
        
    // Restore all mocks to their original state to ensure a clean slate before applying new mocks
    vi.restoreAllMocks();
        
    // Setup browser API spies/mocks
    vi.spyOn(global.URL, 'createObjectURL').mockImplementation(mockCreateObjectURL);
    vi.spyOn(global.URL, 'revokeObjectURL').mockImplementation(mockRevokeObjectURL);
              
    // Directly assign the mock to global.document.createElement
    global.document.createElement = vi.fn((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'a') {
        const mockAnchor = {
          href: '',
          download: '',
          click: mockAnchorClick,
          ownerDocument: global.document,
          nodeName: 'A',
          // Minimal properties to satisfy appendChild on a real JSDOM body
          appendChild: vi.fn(),
          removeChild: vi.fn(),
          setAttribute: vi.fn(),
          getAttribute: vi.fn(),
          dataset: {},
          style: {},
          classList: { add: vi.fn(), remove: vi.fn() },
        } as unknown as HTMLAnchorElement; 
        return mockAnchor;
      }
      // For other elements, call the stored original createElement
      return originalCreateElement.call(global.document, tagName, options);
    });
        
    vi.spyOn(global.document.body, 'appendChild').mockImplementation(mockAppendChild);
    vi.spyOn(global.document.body, 'removeChild').mockImplementation(mockRemoveChild);
  });

  it('should export chat as Markdown (.txt)', async () => {
    mockCurrentChat.value = {
      id: 'test-chat-id',
      title: 'Predefined Chat Title',
      root: { items: [] },
      currentLeafId: 'msg-2',
      debugEnabled: false,
    };
    mockActiveMessages.value = [
      { id: 'msg-1', role: 'user', content: 'Hello AI', timestamp: Date.now(), replies: { items: [] } },
      { id: 'msg-2', role: 'assistant', content: 'Hello User', timestamp: Date.now(), replies: { items: [] } },
    ];

    const wrapper = shallowMount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
      
    await nextTick(); // Ensure component is rendered and mocks are applied

    const exportButton = wrapper.find('button[title="Export Chat"]');
    expect(exportButton.exists()).toBe(true);
    await exportButton.trigger('click');

    expect(mockCreateObjectURL).toHaveBeenCalledOnce();
    expect(mockAnchorClick).toHaveBeenCalledOnce();
    expect(mockAppendChild).toHaveBeenCalledWith(expect.any(Object));
    expect(mockRemoveChild).toHaveBeenCalledWith(expect.any(Object));

    const blob = (mockCreateObjectURL as Mock).mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/plain;charset=utf-8');

    const text = await blob.text();
    expect(text).toContain('# Predefined Chat Title');
    expect(text).toContain('## User:\nHello AI');
    expect(text).toContain('## AI:\nHello User');

    const link = (mockAppendChild as Mock).mock.calls[0]?.[0];
    expect(link.download).toBe('Predefined Chat Title.txt');
  });

  it('should handle empty chat for markdown export (no current chat)', async () => {
    // @ts-expect-error - explicitly setting to null for test
    mockCurrentChat.value = null; 
    mockActiveMessages.value = [];

    const wrapper = shallowMount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });

    await nextTick();

    // Header (and export button) should not exist if currentChat is null
    const exportButton = wrapper.find('button[title="Export Chat"]');
    expect(exportButton.exists()).toBe(false);

    expect(mockCreateObjectURL).not.toHaveBeenCalled();
    expect(mockAnchorClick).not.toHaveBeenCalled();
  });

  it('should export with default title if current chat title is empty', async () => {
    mockCurrentChat.value = {
      id: 'test-chat-id-2',
      title: '', // Empty title
      root: { items: [] },
      currentLeafId: 'msg-3',
      debugEnabled: false,
    };
    mockActiveMessages.value = [
      { id: 'msg-3', role: 'user', content: 'Another message', timestamp: Date.now(), replies: { items: [] } },
    ];

    const wrapper = shallowMount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });

    await nextTick();

    const exportButton = wrapper.find('button[title="Export Chat"]');
    await exportButton.trigger('click');

    const blob = (mockCreateObjectURL as Mock).mock.calls[0]?.[0];
    const text = await blob.text();
    expect(text).toContain('# Untitled Chat');
    expect(text).toContain('## User:\nAnother message');

    const link = (mockAppendChild as Mock).mock.calls[0]?.[0];
    expect(link.download).toBe('untitled_chat.txt');
  });

  it('should handle empty active messages for export', async () => {
    mockCurrentChat.value = {
      id: 'test-chat-id-3',
      title: 'Chat with no messages',
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false,
    };
    mockActiveMessages.value = []; // Empty messages

    const wrapper = shallowMount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
      
    await nextTick();

    const exportButton = wrapper.find('button[title="Export Chat"]');
    await exportButton.trigger('click');

    expect(mockCreateObjectURL).toHaveBeenCalledOnce();
    expect(mockAnchorClick).toHaveBeenCalledOnce();

    const blob = (mockCreateObjectURL as Mock).mock.calls[0]?.[0];
    const text = await blob.text();
    expect(text).toContain('# Chat with no messages');
    expect(text).not.toContain('## User:');
    expect(text).not.toContain('## AI:');

    const link = (mockAppendChild as Mock).mock.calls[0]?.[0];
    expect(link.download).toBe('Chat with no messages.txt');
  });
});
