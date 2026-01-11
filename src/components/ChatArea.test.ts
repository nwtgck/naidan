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
  isMaximized: boolean;
  adjustTextareaHeight: () => void;
  input: string;
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
  let scrollTopSetterSpy: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStreaming.value = false;
    mockActiveMessages.value = [];
    document.body.innerHTML = '<div id="app"></div>';
    scrollTopSetterSpy = vi.fn();
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
        scrollTopSetterSpy(val);
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
    
    // Settle initial mount scrolls
    await flushPromises();
    await nextTick();
    scrollTopSetterSpy.mockClear();

    mockActiveMessages.value = [{ id: '1', role: 'user', content: 'hello', timestamp: Date.now(), replies: { items: [] } }];
    
    await flushPromises();
    await nextTick();
    await nextTick();

    expect(scrollTopSetterSpy).toHaveBeenCalledWith(1000);
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
    
    await flushPromises();
    await nextTick();
    
    // Set at bottom (scrollHeight 1000 - clientHeight 500 = 500)
    container.scrollTop = 500; 
    scrollTopSetterSpy.mockClear();

    mockStreaming.value = true;
    mockActiveMessages.value[0]!.content = 'Thinking...';
    
    await flushPromises();
    await nextTick();
    await nextTick();
    
    expect(scrollTopSetterSpy).toHaveBeenCalledWith(1000);
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
    
    await flushPromises();
    await nextTick();
    
    // Set scrolled up (not at bottom)
    container.scrollTop = 100; 
    scrollTopSetterSpy.mockClear();

    mockStreaming.value = true;
    mockActiveMessages.value[0]!.content = 'Thinking...';
    
    await flushPromises();
    await nextTick();
    await nextTick();
    
    expect(scrollTopSetterSpy).not.toHaveBeenCalledWith(1000);
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
    
    await flushPromises();
    await nextTick();
    
    container.scrollTop = 500; // at bottom
    scrollTopSetterSpy.mockClear();

    mockStreaming.value = true;
    mockActiveMessages.value[0]!.content += ' exceeded';
    
    await flushPromises();
    await nextTick();
    await nextTick();
    
    expect(scrollTopSetterSpy).not.toHaveBeenCalledWith(1000);
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
    await nextTick(); // Add extra nextTick for stability
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

describe('ChatArea Textarea Sizing', () => {
  const mockWindowInnerHeight = 1000; // Mock viewport height for 80vh calculation
  let originalGetComputedStyle: typeof window.getComputedStyle; // Declared here

  // Helper to mock textarea dimensions (scrollHeight, offsetHeight)
  function mockTextareaDimensions(textarea: HTMLTextAreaElement, scrollHeight: number, offsetHeight?: number) {
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(textarea, 'offsetHeight', { configurable: true, value: offsetHeight ?? scrollHeight }); // For clientHeight to be non-zero
    // For clientHeight calculation (offsetHeight - border - padding)
    // verticalPadding in mock getComputedStyle is 12+12+1+1 = 26
    Object.defineProperty(textarea, 'clientHeight', { configurable: true, value: (offsetHeight ?? scrollHeight) - 26 }); 
  }

  beforeAll(() => {
    originalGetComputedStyle = window.getComputedStyle; // Initialized once
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

    // Mock window.innerHeight for 80vh calculation
    Object.defineProperty(window, 'innerHeight', { writable: true, value: mockWindowInnerHeight });
    
    // Mock getComputedStyle for textarea to control line-height, padding, border
    // This is crucial for the new adjustTextareaHeight logic
    vi.spyOn(window, 'getComputedStyle').mockImplementation((elt: Element, pseudoElt?: string | null) => {
      // Only return custom computed style for textarea with data-testid='chat-input'
      if (elt instanceof HTMLTextAreaElement && elt.dataset.testid === 'chat-input') {
        // Use a base computed style and override
        return {
          ...originalGetComputedStyle.call(window, elt, pseudoElt), // Call original for default properties
          lineHeight: '24px', // Mock line-height for calculation
          paddingTop: '12px',
          paddingBottom: '12px',
          borderTopWidth: '1px',
          borderBottomWidth: '1px',
          boxSizing: 'border-box', // Crucial for offsetHeight/clientHeight calculation consistency
        } as CSSStyleDeclaration;
      }
      // For all other elements or if not our target, call the original method
      return originalGetComputedStyle.call(window, elt, pseudoElt);
    });
  });

  it('should initialize textarea height to a single line height', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Mock initial dimensions (single line)
    mockTextareaDimensions(textarea, 24); // scrollHeight for 1 line of text
    // Manually trigger adjustTextareaHeight after mocking dimensions for initial state
    (wrapper.vm as unknown as ChatAreaExposed).adjustTextareaHeight();
    await nextTick();

    const expectedHeight = 50; // 1 line (24) + padding (24) + border (2) = 50
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedHeight);
    expect(textarea.style.overflowY).toBe('hidden');
  });

  it('should disable standard textarea resize handle', async () => {
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect(textarea.classes()).toContain('resize-none');
  });

  it('should show maximize button only when content exceeds 6 lines', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Initial state: empty input, no button
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(false);

    // Typing 3 lines: still no button
    (wrapper.vm as unknown as ChatAreaExposed).input = 'Line 1\nLine 2\nLine 3';
    mockTextareaDimensions(textarea, 24 * 3);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(false);

    // Typing 7 lines: button appears
    (wrapper.vm as unknown as ChatAreaExposed).input = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7';
    mockTextareaDimensions(textarea, 24 * 7 + 26); // scrollHeight > maxSixLinesHeight (170)
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(true);
  });

  it('should expand textarea to 80% viewport height when maximized and stay there even with small input', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Make it long enough to show button
    (wrapper.vm as unknown as ChatAreaExposed).input = 'A'.repeat(500);
    mockTextareaDimensions(textarea, 500); 
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const maximizeButton = wrapper.find('[data-testid="maximize-button"]');
    expect(maximizeButton.exists()).toBe(true);

    // Click maximize button
    await maximizeButton.trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const expected80vh = mockWindowInnerHeight * 0.8;
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expected80vh);
    
    // Typing small content should NOT shrink it while maximized
    (wrapper.vm as unknown as ChatAreaExposed).input = 'small content';
    mockTextareaDimensions(textarea, 24); 
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expected80vh);

    // Click minimize button
    await maximizeButton.trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    // After minimize, it should shrink to content size (single line since input is 'small content')
    const expectedHeightAfterMinimize = 50;
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedHeightAfterMinimize);
  });

  it('should reset maximized state after sending a message', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Fill content and maximize
    (wrapper.vm as unknown as ChatAreaExposed).input = 'Message to send';
    mockTextareaDimensions(textarea, 500);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    
    const maximizeButton = wrapper.find('[data-testid="maximize-button"]');
    await maximizeButton.trigger('click');
    await wrapper.vm.$nextTick();
    
    expect(parseFloat(textarea.style.height)).toBeCloseTo(mockWindowInnerHeight * 0.8);

    // Mock sendMessage to be a slow promise so we can control the flow
    let resolveSendMessage: (val?: void) => void;
    mockSendMessage.mockReturnValue(new Promise<void>(resolve => {
      resolveSendMessage = resolve;
    }));

    // Send the message
    const sendPromise = (wrapper.vm as unknown as ChatAreaExposed).handleSend();
    // After sending, the input is cleared, so we must mock the scrollHeight accordingly
    mockTextareaDimensions(textarea, 24);
    
    resolveSendMessage!();
    await sendPromise;
    await nextTick();
    await nextTick();

    // After send, maximized should be false and height should be reset to single line
    expect(parseFloat(textarea.style.height)).toBeCloseTo(50);
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(false);
  });

  it('should reset height to minimum when handleSend starts even if it was at 6 lines', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Fill content to 6 lines (not maximized)
    (wrapper.vm as unknown as ChatAreaExposed).input = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6';
    mockTextareaDimensions(textarea, 24 * 6 + 26); 
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(170);

    // Start sending
    const sendPromise = (wrapper.vm as unknown as ChatAreaExposed).handleSend();
    
    // Clear mock dimensions to represent cleared input
    mockTextareaDimensions(textarea, 24);
    await nextTick();
    await nextTick();
    
    expect(parseFloat(textarea.style.height)).toBeCloseTo(50);
    await sendPromise;
  });

  it('should reset maximized state IMMEDIATELY when handleSend starts', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Fill content and maximize
    (wrapper.vm as unknown as ChatAreaExposed).input = 'Message to send';
    mockTextareaDimensions(textarea, 500);
    await wrapper.vm.$nextTick();
    
    const maximizeButton = wrapper.find('[data-testid="maximize-button"]');
    await maximizeButton.trigger('click');
    await wrapper.vm.$nextTick();
    expect((wrapper.vm as unknown as ChatAreaExposed).isMaximized).toBe(true);

    // Mock sendMessage to be a slow promise
    let resolveSendMessage: (val?: void) => void;
    mockSendMessage.mockReturnValue(new Promise<void>(resolve => {
      resolveSendMessage = resolve;
    }));

    // Start sending but do not await yet
    const sendPromise = (wrapper.vm as unknown as ChatAreaExposed).handleSend();
    
    // Immediate check
    expect((wrapper.vm as unknown as ChatAreaExposed).isMaximized).toBe(false);
    
    // After nextTick, height should already be adjusting back
    mockTextareaDimensions(textarea, 24); 
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(50);

    // Finally resolve the promise to clean up
    resolveSendMessage!();
    await sendPromise;
  });

  it('should hide maximize button when content is deleted below 6 lines', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Fill content to show button
    (wrapper.vm as unknown as ChatAreaExposed).input = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7';
    mockTextareaDimensions(textarea, 24 * 7 + 26);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(true);

    // Clear content
    (wrapper.vm as unknown as ChatAreaExposed).input = '';
    mockTextareaDimensions(textarea, 24);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(false);
  });

  it('should scroll to bottom when textarea height increases to keep messages visible', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    // Setup scroll mock for container
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 500 });
    let internalScrollTop = 500; // already at bottom
    const scrollTopSpy = vi.fn();
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => internalScrollTop,
      set: (val) => { internalScrollTop = val; scrollTopSpy(val); },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    mockTextareaDimensions(textarea, 24);
    await nextTick();
    scrollTopSpy.mockClear();

    // Simulate textarea expansion (1 line -> 3 lines)
    (wrapper.vm as unknown as ChatAreaExposed).input = 'Line 1\nLine 2\nLine 3';
    mockTextareaDimensions(textarea, 24 * 3);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    // It should trigger scrollToBottom to compensate for the smaller container
    expect(scrollTopSpy).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('should not be extremely small when input is empty (reproduce and fix bug)', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Type some content to make it expand
    (wrapper.vm as unknown as ChatAreaExposed).input = 'Some content to expand textarea\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6';
    mockTextareaDimensions(textarea, 24 * 6 + 26); // Mock full 6 lines
    (wrapper.vm as unknown as ChatAreaExposed).adjustTextareaHeight();
    await nextTick();
    const expandedHeight = parseFloat(textarea.style.height);
    expect(expandedHeight).toBeCloseTo(170);

    // Clear the input
    (wrapper.vm as unknown as ChatAreaExposed).input = '';
    mockTextareaDimensions(textarea, 24); // After clearing, scrollHeight should be single line
    await wrapper.vm.$nextTick(); // Trigger input watcher
    await wrapper.vm.$nextTick(); // Allow adjustTextareaHeight to run

    // After clearing, height should revert to initial single-line height, not 0
    expect(parseFloat(textarea.style.height)).toBeCloseTo(50);
    expect(textarea.style.overflowY).toBe('hidden');
  });

  it('should reset maximized state when switching to a different chat', async () => {
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    // Set to maximized
    (wrapper.vm as unknown as ChatAreaExposed).isMaximized = true;
    
    // Simulate chat ID change
    mockCurrentChat.value = { ...mockCurrentChat.value, id: 'chat-2' };
    await nextTick();
    await nextTick();

    expect((wrapper.vm as unknown as ChatAreaExposed).isMaximized).toBe(false);
  });

  it('should handle large text paste by showing the maximize button immediately', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // Simulate pasting 50 lines
    (wrapper.vm as unknown as ChatAreaExposed).input = 'Line\n'.repeat(50);
    mockTextareaDimensions(textarea, 24 * 50);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(true);
    expect(parseFloat(textarea.style.height)).toBeCloseTo(170); // Max 6 lines
  });

  it('should recalculate maximized height on window resize', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Maximize
    (wrapper.vm as unknown as ChatAreaExposed).isMaximized = true;
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    
    expect(parseFloat(textarea.style.height)).toBeCloseTo(800); // 80% of 1000

    // Change window height and trigger resize
    Object.defineProperty(window, 'innerHeight', { writable: true, value: 500 });
    window.dispatchEvent(new Event('resize'));
    await nextTick();

    expect(parseFloat(textarea.style.height)).toBeCloseTo(400); // 80% of 500
  });

  it('should not use transition-all on textarea to avoid height flickering', async () => {
    const wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect(textarea.classes()).not.toContain('transition-all');
    expect(textarea.classes()).toContain('transition-colors');
  });

  it('should remain at minimum height for any 1-line content', async () => {
    const wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // lineHeight (24) + verticalPadding (12+12+1+1 = 26) = 50
    // Actually in the test's getComputedStyle mock, padding/border sum to 26px
    // Let's use 50 as the expected minimum based on the mock values.
    const expectedMinHeight = 50; 

    // Test with very short text
    (wrapper.vm as unknown as ChatAreaExposed).input = 'a';
    mockTextareaDimensions(textarea, 24); // scrollHeight for 1 line content
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedMinHeight);

    // Test with longer text that still fits in 1 line
    (wrapper.vm as unknown as ChatAreaExposed).input = 'This is a longer string but still only one line';
    mockTextareaDimensions(textarea, 24); 
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedMinHeight);
    
    // Even if scrollHeight is slightly less (e.g., 20px), it should stay at minHeight (50px)
    mockTextareaDimensions(textarea, 20);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedMinHeight);
  });
});
