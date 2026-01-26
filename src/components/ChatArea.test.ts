import { describe, it, expect, vi, beforeEach, afterEach, type Mock, beforeAll } from 'vitest';
import { mount, flushPromises, VueWrapper } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { nextTick, ref, reactive } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }],
});

import type { MessageNode, Chat } from '../models/types';

// Mock dependencies
const mockSendMessage = vi.fn().mockResolvedValue(true);
const mockAbortChat = vi.fn();
const mockStreaming = ref(false);
const mockAvailableModels = ref<string[]>([]);
const mockFetchingModels = ref(false);
const mockGeneratingTitle = ref(false);
const mockFetchAvailableModels = vi.fn();
const mockGenerateChatTitle = vi.fn();
const mockActiveGenerations = reactive(new Map());
const mockCurrentChat = ref<Chat | null>({
  id: '1', 
  title: 'Test Chat', 
  root: { items: [] } as { items: MessageNode[] },
  currentLeafId: undefined as string | undefined,
  debugEnabled: false, 
  originChatId: undefined as string | undefined,
  modelId: undefined as string | undefined,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
const mockActiveMessages = ref<MessageNode[]>([]);

const mockOpenChatGroup = vi.fn();
const mockMoveChatToGroup = vi.fn();
const mockUpdateChatModel = vi.fn().mockImplementation((id, modelId) => {
  if (mockCurrentChat.value && mockCurrentChat.value.id === id) {
    mockCurrentChat.value.modelId = modelId;
  }
});
const mockSaveChat = vi.fn();
const mockCurrentChatGroup = ref<any>(null);
const mockChatGroups = ref<any[]>([]);
const mockResolvedSettings = ref<any>(null);
const mockInheritedSettings = ref<any>(null);

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: mockCurrentChatGroup,
    chatGroups: mockChatGroups,
    resolvedSettings: mockResolvedSettings,
    inheritedSettings: mockInheritedSettings,
    sendMessage: mockSendMessage,
    updateChatModel: mockUpdateChatModel,
    saveChat: mockSaveChat,
    streaming: mockStreaming,
    activeGenerations: mockActiveGenerations,
    toggleDebug: vi.fn(() => {
      if (mockCurrentChat.value) {
        mockCurrentChat.value.debugEnabled = !mockCurrentChat.value.debugEnabled;
      }
    }),
    activeMessages: mockActiveMessages,
    getSiblings: vi.fn().mockReturnValue([]),
    editMessage: vi.fn(),
    switchVersion: vi.fn(),
    abortChat: mockAbortChat,
    availableModels: mockAvailableModels,
    fetchingModels: mockFetchingModels,
    generatingTitle: mockGeneratingTitle,
    fetchAvailableModels: mockFetchAvailableModels,
    generateChatTitle: mockGenerateChatTitle,
    forkChat: vi.fn().mockResolvedValue('new-id'),
    openChatGroup: mockOpenChatGroup,
    moveChatToGroup: mockMoveChatToGroup,
    isTaskRunning: vi.fn((id: string) => mockStreaming.value || mockActiveGenerations.has(id)),
    isProcessing: vi.fn((id: string) => mockStreaming.value || mockActiveGenerations.has(id)),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointType: 'openai', endpointUrl: 'http://localhost', defaultModelId: 'global-default-model' }),
    availableModels: mockAvailableModels,
    isFetchingModels: mockFetchingModels,
    fetchModels: mockFetchAvailableModels,
  }),
}));

// Mock Mermaid to avoid "document is not defined" errors during tests
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}));

interface ChatAreaExposed {
  scrollToBottom: () => void;
  container: HTMLElement | null;
  handleSend: () => Promise<void>;
  isMaximized: boolean;
  adjustTextareaHeight: () => void;
  input: string;
}

let wrapper: VueWrapper<any> | null = null;

function resetMocks() {
  vi.clearAllMocks();
  mockStreaming.value = false;
  mockActiveGenerations.clear();
  mockActiveMessages.value = [];
  mockAvailableModels.value = ['model-1', 'model-2'];
  mockFetchingModels.value = false;
  mockResolvedSettings.value = {
    modelId: 'global-default-model',
    sources: { modelId: 'global' }
  };
  mockInheritedSettings.value = {
    modelId: 'global-default-model',
    sources: { modelId: 'global' }
  };
  mockCurrentChat.value = {
    id: '1', 
    title: 'Test Chat', 
    root: { items: [] },
    currentLeafId: undefined,
    debugEnabled: false, 
    originChatId: undefined,
    modelId: undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('ChatArea UI States', () => {
  beforeEach(() => {
    resetMocks();
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('should keep the input textarea enabled during streaming', async () => {
    mockStreaming.value = true;
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect((textarea.element as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('should show the abort button and hide the send button during streaming', async () => {
    mockStreaming.value = true;
    if (mockCurrentChat.value) {
      mockActiveGenerations.set(mockCurrentChat.value.id, { controller: new AbortController(), chat: mockCurrentChat.value });
    }
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const abortBtn = wrapper.find('[data-testid="abort-button"]');
    expect(abortBtn.exists()).toBe(true);
    expect(abortBtn.text()).toContain('Esc');
    expect(wrapper.find('[data-testid="send-button"]').exists()).toBe(false);
  });

  it('should display the shortcut text with correct casing (not all uppercase)', () => {
    wrapper = mount(ChatArea, {
      global: {
        stubs: {
          'router-link': true,
          'Logo': true,
          'MessageItem': true,
          'WelcomeScreen': true,
          'ChatSettingsPanel': true,
        },
      },
    });
    const sendBtn = wrapper.find('[data-testid="send-button"]');
    const shortcutText = sendBtn.text();
    
    // Check for "Enter" with capital E and lowercase nter, 
    // ensuring "uppercase" class isn't transforming it.
    expect(shortcutText).toContain('Enter');
    expect(shortcutText).not.toContain('ENTER');
  });

  it('should display the model name with correct casing (not forced to uppercase)', async () => {
    // Set a specifically lowercase model name in settings to test for uppercase transformation
    const testModelName = 'gemma3:1b-lowercase';
    if (mockCurrentChat.value) mockCurrentChat.value.modelId = testModelName;
    
    wrapper = mount(ChatArea, {
      global: {
        plugins: [router],
        stubs: {
          'router-link': true,
          'Logo': true,
          'MessageItem': true,
          'WelcomeScreen': true,
          'ChatSettingsPanel': true,
        },
      },
    });
    
    await nextTick();
    
    const headerText = wrapper.text();
    expect(headerText).toContain(testModelName);
    // Explicitly check that it's NOT transformed to uppercase
    expect(headerText).not.toContain(testModelName.toUpperCase());
  });

  it('should call abortChat when Esc is pressed during streaming', async () => {
    mockStreaming.value = true;
    if (mockCurrentChat.value) {
      mockActiveGenerations.set(mockCurrentChat.value.id, { controller: new AbortController(), chat: mockCurrentChat.value });
    }
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const textarea = wrapper.find('[data-testid="chat-input"]');
    await textarea.trigger('keydown.esc');
    expect(mockAbortChat).toHaveBeenCalled();
  });

  it('should show the send button with shortcut text when not streaming', async () => {
    mockStreaming.value = false;
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const sendBtn = wrapper.find('[data-testid="send-button"]');
    expect(sendBtn.exists()).toBe(true);
    // Shortcut text depends on OS, but should contain either 'Enter' or 'Cmd'/'Ctrl'
    expect(sendBtn.text()).toMatch(/(Enter|Cmd|Ctrl)/);
  });

  it('should show the chat inspector when debug mode is enabled', async () => {
    if (mockCurrentChat.value) mockCurrentChat.value.debugEnabled = true;
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const inspector = wrapper.find('[data-testid="chat-inspector"]');
    expect(inspector.exists()).toBe(true);
    expect(inspector.text()).toContain('Metadata');
  });

  it('should show the regenerate title button and call generateChatTitle when clicked', async () => {
    mockActiveMessages.value = [{ id: 'm1', role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const btn = wrapper.find('[data-testid="regenerate-title-button"]');
    expect(btn.exists()).toBe(true);
    
    await btn.trigger('click');
    expect(mockGenerateChatTitle).toHaveBeenCalled();
  });

  it('should spin and disable the regenerate title button while generatingTitle is true', async () => {
    mockActiveMessages.value = [{ id: 'm1', role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    mockGeneratingTitle.value = true;
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const btn = wrapper.find('[data-testid="regenerate-title-button"]');
    expect(btn.classes()).toContain('animate-spin');
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('should hide the chat inspector when debug mode is disabled', async () => {
    if (mockCurrentChat.value) mockCurrentChat.value.debugEnabled = false;
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    expect(wrapper.find('[data-testid="chat-inspector"]').exists()).toBe(false);
  });

  it('should render header icons (Export, Settings, More)', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    expect(wrapper.find('button[title="Export Chat"]').exists()).toBe(true);
    expect(wrapper.find('button[title="Chat Settings & Model Override"]').exists()).toBe(true);
    expect(wrapper.find('button[title="More Actions"]').exists()).toBe(true);
  });

  it('should show jump to origin button when originChatId is present', async () => {
    if (mockCurrentChat.value) mockCurrentChat.value.originChatId = 'original-id';
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    expect(wrapper.find('button[title="Jump to original chat"]').exists()).toBe(true);
  });

  it('should show move to group menu and call moveChatToGroup when a group is selected', async () => {
    mockChatGroups.value = [{ id: 'group-1', name: 'Group 1' }];
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const btn = wrapper.find('[data-testid="move-to-group-button"]');
    expect(btn.exists()).toBe(true);
    
    // Open menu
    await btn.trigger('click');
    expect(wrapper.text()).toContain('Move to Group');
    expect(wrapper.text()).toContain('Group 1');
    expect(wrapper.text()).toContain('Top Level');

    // Select group
    const groupBtn = wrapper.findAll('button').find(b => b.text().includes('Group 1'));
    await groupBtn?.trigger('click');
    
    expect(mockMoveChatToGroup).toHaveBeenCalledWith('1', 'group-1');
  });

  describe('Custom Overrides Indicator', () => {
    it('shows indicator when endpointType is overridden', async () => {
      mockCurrentChat.value = reactive({
        id: 'c1', title: 'T', root: { items: [] },
        endpointType: 'ollama',
        currentLeafId: undefined, debugEnabled: false, originChatId: undefined,
        modelId: undefined, createdAt: 0, updatedAt: 0
      }) as any;
      wrapper = mount(ChatArea, { global: { plugins: [router] } });
      expect(wrapper.find('[data-testid="custom-overrides-indicator"]').exists()).toBe(true);
    });

    it('shows indicator when systemPrompt is overridden', async () => {
      mockCurrentChat.value = reactive({
        id: 'c1', title: 'T', root: { items: [] },
        systemPrompt: { content: 'test', behavior: 'override' },
        currentLeafId: undefined, debugEnabled: false, originChatId: undefined,
        modelId: undefined, createdAt: 0, updatedAt: 0
      }) as any;
      wrapper = mount(ChatArea, { global: { plugins: [router] } });
      expect(wrapper.find('[data-testid="custom-overrides-indicator"]').exists()).toBe(true);
    });

    it('shows indicator when lmParameters are overridden', async () => {
      mockCurrentChat.value = reactive({
        id: 'c1', title: 'T', root: { items: [] },
        lmParameters: { temperature: 0.5 },
        currentLeafId: undefined, debugEnabled: false, originChatId: undefined,
        modelId: undefined, createdAt: 0, updatedAt: 0
      }) as any;
      wrapper = mount(ChatArea, { global: { plugins: [router] } });
      expect(wrapper.find('[data-testid="custom-overrides-indicator"]').exists()).toBe(true);
    });

    it('does not show indicator when no overrides are present', async () => {
      mockCurrentChat.value = reactive({
        id: 'c1', title: 'T', root: { items: [] },
        currentLeafId: undefined, debugEnabled: false, originChatId: undefined,
        modelId: undefined, createdAt: 0, updatedAt: 0
      }) as any;
      wrapper = mount(ChatArea, { global: { plugins: [router] } });
      expect(wrapper.find('[data-testid="custom-overrides-indicator"]').exists()).toBe(false);
    });
  });
});

describe('ChatArea Scrolling Logic', () => {
  let scrollTopSetterSpy: Mock;

  beforeEach(() => {
    resetMocks();
    document.body.innerHTML = '<div id="app"></div>';
    scrollTopSetterSpy = vi.fn();
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
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
    wrapper = mount(ChatArea, { 
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
  });

  it('should scroll during streaming if user is at the bottom', async () => {
    mockActiveMessages.value = [{ id: '1', role: 'assistant', content: '', timestamp: Date.now(), replies: { items: [] } }];
    
    wrapper = mount(ChatArea, { 
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
  });

  it('should NOT scroll during streaming if user has scrolled up', async () => {
    mockActiveMessages.value = [{ id: '1', role: 'assistant', content: '', timestamp: Date.now(), replies: { items: [] } }];
    
    wrapper = mount(ChatArea, { 
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
  });

  it('should stop scrolling after content exceeds 400 characters', async () => {
    mockActiveMessages.value = [{ id: '1', role: 'assistant', content: 'A'.repeat(400), timestamp: Date.now(), replies: { items: [] } }];
    
    wrapper = mount(ChatArea, { 
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
  });
});

describe('ChatArea Focus', () => {
  beforeEach(() => {
    resetMocks();
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('should focus the textarea after sending a message', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
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
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    
    await nextTick();
    await nextTick(); // Add extra nextTick for stability
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect(document.activeElement).toBe(textarea.element);
  });
});

describe('ChatArea Export Functionality', () => {
  // Mock browser APIs for file download
  const mockCreateObjectURL = vi.fn((blob: Blob | MediaSource) => {
    // Mock Blob content access for testing
    if (blob instanceof Blob) {
      // We can't easily mock blob.text() without implementing the whole Blob interface
      // But we can check the blob content in the test itself if needed
      (blob as any).text = async () => {
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsText(blob);
        });
      };
    }
    return 'blob:mockurl';
  });
  const mockRevokeObjectURL = vi.fn();
  const mockAnchorClick = vi.fn();
  const mockAppendChild = vi.fn();
  const mockRemoveChild = vi.fn();
  let originalCreateElement: any;
        
  beforeAll(() => {
    // Capture the original createElement once, before any mocks are applied
    originalCreateElement = document.createElement;
  });
        
  beforeEach(() => {
    resetMocks();
    document.body.innerHTML = '<div id="app"></div>';
        
    // Setup browser API spies/mocks
    vi.spyOn(URL, 'createObjectURL').mockImplementation(mockCreateObjectURL as any);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(mockRevokeObjectURL);
              
    // Robust mock for document.createElement to avoid breaking Vue internals
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      // Create the real element first
      const el = originalCreateElement.call(document, tagName);
      
      // If it's an anchor tag, attach our spy
      if (tagName === 'a') {
        // Also attach spy to the real element's click just in case
        vi.spyOn(el, 'click').mockImplementation(mockAnchorClick);
        return el;
      }
      return el;
    });
        
    vi.spyOn(document.body, 'appendChild').mockImplementation(mockAppendChild);
    vi.spyOn(document.body, 'removeChild').mockImplementation(mockRemoveChild);
  });

  afterEach(() => {
    // Restore all mocks to their original state to ensure a clean slate before applying new mocks
    vi.restoreAllMocks();
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('should export chat as Markdown (.txt)', async () => {
    mockCurrentChat.value = {
      id: 'test-chat-id',
      title: 'Predefined Chat Title',
      root: { items: [] },
      currentLeafId: 'msg-2',
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockActiveMessages.value = [
      { id: 'msg-1', role: 'user', content: 'Hello AI', timestamp: Date.now(), replies: { items: [] } },
      { id: 'msg-2', role: 'assistant', content: 'Hello User', timestamp: Date.now(), replies: { items: [] } },
    ];

    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
      
    await nextTick(); // Ensure component is rendered and mocks are applied

    const exportButton = wrapper.find('button[title="Export Chat"]');
    expect(exportButton.exists()).toBe(true);
    await exportButton.trigger('click');

    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(mockAnchorClick).toHaveBeenCalled();
    expect(mockAppendChild).toHaveBeenCalledWith(expect.any(Object));
    expect(mockRemoveChild).toHaveBeenCalledWith(expect.any(Object));

    // Verify blob content (simplified check since we mocked createObjectURL)
    const blob = (mockCreateObjectURL as Mock).mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/plain;charset=utf-8');

    const text = await blob.text();
    expect(text).toContain('# Predefined Chat Title');
    expect(text).toContain('## User:\nHello AI');
    expect(text).toContain('## AI:\nHello User');

    // Verify filename
    const link = (mockAppendChild as Mock).mock.calls[0]?.[0];
    expect(link.download).toBe('Predefined Chat Title.txt');
  });

  it('should handle empty chat for markdown export (no current chat)', async () => {
    mockCurrentChat.value = null; 
    mockActiveMessages.value = [];

    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });

    await nextTick();

    // Header (and export button) should not exist if currentChat is null
    const exportButton = wrapper.find('button[title="Export Chat"]');
    expect(exportButton.exists()).toBe(false);

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(mockAnchorClick).not.toHaveBeenCalled();
  });

  it('should export with default title if current chat title is empty', async () => {
    mockCurrentChat.value = {
      id: 'test-chat-id-2',
      title: '', // Empty title
      root: { items: [] },
      currentLeafId: 'msg-3',
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockActiveMessages.value = [
      { id: 'msg-3', role: 'user', content: 'Another message', timestamp: Date.now(), replies: { items: [] } },
    ];

    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });

    await nextTick();

    const exportButton = wrapper.find('button[title="Export Chat"]');
    await exportButton.trigger('click');

    // Just verify the calls happened
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(mockAnchorClick).toHaveBeenCalled();

    const blob = (mockCreateObjectURL as Mock).mock.calls[0]?.[0];
    const text = await blob.text();
    expect(text).toContain('# New Chat');
    expect(text).toContain('## User:\nAnother message');

    const link = (mockAppendChild as Mock).mock.calls[0]?.[0];
    expect(link.download).toBe('new_chat.txt');
  });

  it('should handle empty active messages for export', async () => {
    mockCurrentChat.value = {
      id: 'test-chat-id-3',
      title: 'Chat with no messages',
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockActiveMessages.value = []; // Empty messages

    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
      
    await nextTick();

    const exportButton = wrapper.find('button[title="Export Chat"]');
    await exportButton.trigger('click');

    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(mockAnchorClick).toHaveBeenCalled();

    const blob = (mockCreateObjectURL as Mock).mock.calls[0]?.[0];
    const text = await blob.text();
    expect(text).toContain('# Chat with no messages');
    
    const link = (mockAppendChild as Mock).mock.calls[0]?.[0];
    expect(link.download).toBe('Chat with no messages.txt');
  });
});

describe('ChatArea Textarea Sizing', () => {
  const mockWindowInnerHeight = 1000; // Mock viewport height for 80vh calculation
  let originalGetComputedStyle: any;

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
    resetMocks();
    document.body.innerHTML = '<div id="app"></div>';

    // Mock window.innerHeight for 80vh calculation
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: mockWindowInnerHeight });
    
    // Mock getComputedStyle for textarea to control line-height, padding, border
    // This is crucial for the new adjustTextareaHeight logic
    vi.spyOn(window, 'getComputedStyle').mockImplementation((elt: Element) => {
      // Only return custom computed style for textarea with data-testid='chat-input'
      if (elt instanceof HTMLTextAreaElement && (elt.dataset.testid === 'chat-input' || elt.tagName === 'TEXTAREA')) {
        // Use a base computed style and override
        return {
          lineHeight: '24px', // Mock line-height for calculation
          paddingTop: '12px',
          paddingBottom: '12px',
          borderTopWidth: '1px',
          borderBottomWidth: '1px',
          boxSizing: 'border-box', // Crucial for offsetHeight/clientHeight calculation consistency
        } as any;
      }
      // For all other elements or if not our target, call the original method
      return originalGetComputedStyle.call(window, elt);
    });
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('should initialize textarea height to a single line height', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Mock initial dimensions (single line)
    mockTextareaDimensions(textarea, 24); // scrollHeight for 1 line of text
    // Manually trigger adjustTextareaHeight after mocking dimensions for initial state
    (wrapper.vm as any).adjustTextareaHeight();
    await nextTick();

    const expectedHeight = 50; // 1 line (24) + padding (24) + border (2) = 50
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedHeight);
    expect(textarea.style.overflowY).toBe('hidden');
  });

  it('should disable standard textarea resize handle', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect(textarea.classes()).toContain('resize-none');
  });

  it('should show maximize button only when content exceeds 6 lines', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Initial state: empty input, no button
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(false);

    // Typing 3 lines: still no button
    (wrapper.vm as any).input = 'Line 1\nLine 2\nLine 3';
    mockTextareaDimensions(textarea, 24 * 3);
    await nextTick();
    await nextTick();
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(false);

    // Typing 7 lines: button appears
    (wrapper.vm as any).input = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7';
    mockTextareaDimensions(textarea, 24 * 7 + 26); // scrollHeight > maxSixLinesHeight (170)
    await nextTick();
    await nextTick();
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(true);
  });

  it('should expand textarea to 80% viewport height when maximized and stay there even with small input', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Make it long enough to show button
    (wrapper.vm as any).input = 'A'.repeat(500);
    mockTextareaDimensions(textarea, 500); 
    await nextTick();
    await nextTick();

    const maximizeButton = wrapper.find('[data-testid="maximize-button"]');
    expect(maximizeButton.exists()).toBe(true);

    // Click maximize button
    await maximizeButton.trigger('click');
    await nextTick();
    await nextTick();

    const expected70vh = mockWindowInnerHeight * 0.7;
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expected70vh);
    
    // Typing small content should NOT shrink it while maximized
    (wrapper.vm as any).input = 'small content';
    mockTextareaDimensions(textarea, 24); 
    await nextTick();
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expected70vh);

    // Click minimize button
    await maximizeButton.trigger('click');
    await nextTick();
    await nextTick();

    // After minimize, it should shrink to content size (single line since input is 'small content')
    const expectedHeightAfterMinimize = 50;
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedHeightAfterMinimize);
  });

  it('should reset maximized state after sending a message', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Fill content and maximize
    (wrapper.vm as any).input = 'Message to send';
    mockTextareaDimensions(textarea, 500);
    await nextTick();
    await nextTick();
    
    const maximizeButton = wrapper.find('[data-testid="maximize-button"]');
    await maximizeButton.trigger('click');
    await nextTick();
    
    expect(parseFloat(textarea.style.height)).toBeCloseTo(mockWindowInnerHeight * 0.7);

    // Mock sendMessage to be a slow promise so we can control the flow
    let resolveSendMessage: (val: boolean) => void;
    mockSendMessage.mockReturnValue(new Promise<boolean>(resolve => {
      resolveSendMessage = resolve;
    }));

    // Send the message
    const sendPromise = (wrapper.vm as any).handleSend();
    // After sending, the input is cleared, so we must mock the scrollHeight accordingly
    mockTextareaDimensions(textarea, 24);
    
    resolveSendMessage!(true);
    await sendPromise;
    await nextTick();
    await nextTick();

    // After send, maximized should be false and height should be reset to single line
    expect(parseFloat(textarea.style.height)).toBeCloseTo(50);
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(false);
  });

  it('should reset height to minimum when handleSend starts even if it was at 6 lines', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Fill content to 6 lines (not maximized)
    (wrapper.vm as any).input = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6';
    mockTextareaDimensions(textarea, 24 * 6 + 26); 
    await nextTick();
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(170);

    // Start sending
    const sendPromise = (wrapper.vm as any).handleSend();
    
    // Height reset now happens AFTER sendMessage resolves
    await mockSendMessage.mock.results[0]?.value; 
    await sendPromise;

    // Clear mock dimensions to represent cleared input
    mockTextareaDimensions(textarea, 24);
    await nextTick();
    await nextTick();
    
    expect(parseFloat(textarea.style.height)).toBeCloseTo(50);
  });

  it('should reset maximized state IMMEDIATELY when handleSend starts', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Fill content and maximize
    (wrapper.vm as any).input = 'Message to send';
    mockTextareaDimensions(textarea, 500);
    await nextTick();
    
    const maximizeButton = wrapper.find('[data-testid="maximize-button"]');
    await maximizeButton.trigger('click');
    await nextTick();
    expect((wrapper.vm as any).isMaximized).toBe(true);

    // Mock sendMessage to be a slow promise
    let resolveSendMessage: (val: boolean) => void;
    mockSendMessage.mockReturnValue(new Promise<boolean>(resolve => {
      resolveSendMessage = resolve;
    }));

    // Start sending but do not await yet
    const sendPromise = (wrapper.vm as any).handleSend();
    
    // Immediate check
    expect((wrapper.vm as any).isMaximized).toBe(false);
    
    // Resolve sendMessage
    resolveSendMessage!(true);
    await sendPromise;

    // After nextTick, height should already be adjusting back
    mockTextareaDimensions(textarea, 24); 
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(50);
  });

  it('should hide maximize button when content is deleted below 6 lines', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Fill content to show button
    (wrapper.vm as any).input = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7';
    mockTextareaDimensions(textarea, 24 * 7 + 26);
    await nextTick();
    await nextTick();
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(true);

    // Clear content
    (wrapper.vm as any).input = '';
    mockTextareaDimensions(textarea, 24);
    await nextTick();
    await nextTick();
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(false);
  });

  it('should scroll to bottom when textarea height increases to keep messages visible', async () => {
    wrapper = mount(ChatArea, {
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
    (wrapper.vm as any).input = 'Line 1\nLine 2\nLine 3';
    mockTextareaDimensions(textarea, 24 * 3);
    await nextTick();
    await nextTick();

    // It should trigger scrollToBottom to compensate for the smaller container
    expect(scrollTopSpy).toHaveBeenCalled();
  });

  it('should not be extremely small when input is empty (reproduce and fix bug)', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Type some content to make it expand
    (wrapper.vm as any).input = 'Some content to expand textarea\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6';
    mockTextareaDimensions(textarea, 24 * 6 + 26); // Mock full 6 lines
    (wrapper.vm as any).adjustTextareaHeight();
    await nextTick();
    const expandedHeight = parseFloat(textarea.style.height);
    expect(expandedHeight).toBeCloseTo(170);

    // Clear the input
    (wrapper.vm as any).input = '';
    mockTextareaDimensions(textarea, 24); // After clearing, scrollHeight should be single line
    await nextTick(); // Trigger input watcher
    await nextTick(); // Allow adjustTextareaHeight to run

    // After clearing, height should revert to initial single-line height, not 0
    expect(parseFloat(textarea.style.height)).toBeCloseTo(50);
    expect(textarea.style.overflowY).toBe('hidden');
  });

  it('should NOT clear input if sendMessage returns false (regression: onboarding)', async () => {
    mockSendMessage.mockResolvedValueOnce(false);
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    await textarea.setValue('Keep this text');
    
    const sendBtn = wrapper.find('[data-testid="send-button"]');
    await sendBtn.trigger('click');

    await flushPromises();

    expect(textarea.element.value).toBe('Keep this text');
  });

  it('should clear input IMMEDIATELY after handleSend returns, even if streaming continues (Regression Test)', async () => {
    // 1. Setup: mockSendMessage returns immediately while setting streaming to true
    mockSendMessage.mockImplementationOnce(async () => {
      // Simulate that generation starts in background
      mockStreaming.value = true;
      return true; //sendMessage returns success immediately after storage commit
    });

    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    await textarea.setValue('This should be cleared');
    
    // 2. Act: Click send
    const sendBtn = wrapper.find('[data-testid="send-button"]');
    await sendBtn.trigger('click');

    // 3. Assert: Input is cleared even if mockStreaming is still true
    await flushPromises();
    expect(textarea.element.value).toBe('');
    expect(mockStreaming.value).toBe(true);
  });

  it('should reset maximized state when switching to a different chat', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    // Set to maximized
    (wrapper.vm as any).isMaximized = true;
    
    // Simulate chat ID change
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: 'chat-2' };
    await nextTick();
    await nextTick();

    expect((wrapper.vm as any).isMaximized).toBe(false);
  });

  it('should handle large text paste by showing the maximize button immediately', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // Simulate pasting 50 lines
    (wrapper.vm as any).input = 'Line\n'.repeat(50);
    mockTextareaDimensions(textarea, 24 * 50);
    await nextTick();
    await nextTick();

    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(true);
    expect(parseFloat(textarea.style.height)).toBeCloseTo(170); // Max 6 lines
  });

  it('should recalculate maximized height on window resize', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    
    // Maximize
    (wrapper.vm as any).isMaximized = true;
    await nextTick();
    await nextTick();
    
    expect(parseFloat(textarea.style.height)).toBeCloseTo(700); // 70% of 1000

    // Change window height and trigger resize
    Object.defineProperty(window, 'innerHeight', { writable: true, value: 500 });
    window.dispatchEvent(new Event('resize'));
    await nextTick();

    expect(parseFloat(textarea.style.height)).toBeCloseTo(350); // 70% of 500
  });

  it('should not use transition-all on textarea to avoid height flickering', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect(textarea.classes()).not.toContain('transition-all');
    expect(textarea.classes()).toContain('transition-colors');
  });

  it('should remain at minimum height for any 1-line content', async () => {
    wrapper = mount(ChatArea, {
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
    (wrapper.vm as any).input = 'a';
    mockTextareaDimensions(textarea, 24); // scrollHeight for 1 line content
    await nextTick();
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedMinHeight);

    // Test with longer text that still fits in 1 line
    (wrapper.vm as any).input = 'This is a longer string but still only one line';
    mockTextareaDimensions(textarea, 24); 
    await nextTick();
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedMinHeight);
    
    // Even if scrollHeight is slightly less (e.g., 20px), it should stay at minHeight (50px)
    mockTextareaDimensions(textarea, 20);
    await nextTick();
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedMinHeight);
  });
});

describe('ChatArea Welcome Screen & Suggestions', () => {
  beforeEach(() => {
    resetMocks();
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('should show the welcome screen when there are no messages', async () => {
    wrapper = mount(ChatArea, {
      global: {
        plugins: [router],
        stubs: { WelcomeScreen: { template: '<div data-testid="welcome-screen-stub">Welcome</div>' } },
      },
    });
    
    expect(wrapper.find('[data-testid="welcome-screen-stub"]').exists()).toBe(true);
  });

  it('should fill the input and focus when WelcomeScreen emits select-suggestion', async () => {
    wrapper = mount(ChatArea, {
      attachTo: document.body,
      global: {
        plugins: [router],
        stubs: { WelcomeScreen: true } 
      },
    });
    
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    const focusSpy = vi.spyOn(textarea.element, 'focus');

    const welcomeScreen = wrapper.findComponent({ name: 'WelcomeScreen' });
    await welcomeScreen.vm.$emit('select-suggestion', 'Test Suggestion');
    
    await nextTick();
    await nextTick();
    
    expect((textarea.element as HTMLTextAreaElement).value).toBe('Test Suggestion');
    expect(focusSpy).toHaveBeenCalled();
  });

  it('should hide the welcome screen when messages are present', async () => {
    mockActiveMessages.value = [{ id: '1', role: 'user', content: 'hi', timestamp: Date.now(), replies: { items: [] } }];
    wrapper = mount(ChatArea, {
      global: {
        plugins: [router],
        stubs: { WelcomeScreen: { template: '<div data-testid="welcome-screen-stub">Welcome</div>' } },
      },
    });
    
    expect(wrapper.find('[data-testid="welcome-screen-stub"]').exists()).toBe(false);
  });
});

describe('ChatArea Model Selection', () => {
  beforeEach(() => {
    resetMocks();
    mockAvailableModels.value = ['model-1', 'model-2'];
    mockFetchingModels.value = false;
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('should render available models in the dropdown', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const trigger = wrapper.find('[data-testid="model-selector-trigger"]');
    expect(trigger.exists()).toBe(true);
    
    await trigger.trigger('click');
    
    // The items are buttons in ModelSelector
    const buttons = wrapper.findAll('button');
    const modelButtons = buttons.filter(b => 
      mockAvailableModels.value.includes(b.text())
    );
    
    expect(modelButtons.length).toBe(2);
    expect(modelButtons[0]!.text()).toBe('model-1');
    expect(modelButtons[1]!.text()).toBe('model-2');
  });

  it('should pass a naturally sorted list of models to ModelSelector', async () => {
    mockAvailableModels.value = ['model-10', 'model-2', 'model-1'];
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const selector = wrapper.getComponent({ name: 'ModelSelector' });
    expect(selector.props('models')).toEqual(['model-1', 'model-2', 'model-10']);
  });

  it('should display the global default model name as placeholder', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    const trigger = wrapper.find('[data-testid="model-selector-trigger"]');
    expect(trigger.text()).toBe('global-default-model (Global)');
  });

  it('should trigger updateChatModel when a model is selected in ModelSelector', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    // Open dropdown
    const trigger = wrapper.find('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');
    
    // Select 'model-2'
    const model2Btn = wrapper.findAll('button').find(b => b.text() === 'model-2');
    await model2Btn!.trigger('click');
    
    expect(mockUpdateChatModel).toHaveBeenCalledWith('1', 'model-2');
    expect(mockCurrentChat.value!.modelId).toBe('model-2');
  });

  it('should show loader when fetching models', async () => {
    mockFetchingModels.value = true;
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    expect(wrapper.find('.animate-spin').exists()).toBe(true);
  });

  it('should trigger fetchAvailableModels on mount if chat exists', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    
    expect(mockFetchAvailableModels).toHaveBeenCalled();
  });

  it('should trigger fetchAvailableModels when switching chats', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });
    mockFetchAvailableModels.mockClear();

    // Simulate chat ID change
    if (mockCurrentChat.value) {
      mockCurrentChat.value = { ...mockCurrentChat.value, id: 'chat-new' };
    }
    await nextTick();

    expect(mockFetchAvailableModels).toHaveBeenCalled();
  });

  it('automatically sends message when autoSendPrompt is provided', async () => {
    mockCurrentChat.value = {
      id: '1', 
      title: 'Test Chat', 
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    } as Chat;
    
    wrapper = mount(ChatArea, {
      props: {
        autoSendPrompt: 'automatic message'
      },
      global: {
        plugins: [router],
        stubs: { 'Logo': true, 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true }
      },
    });

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockSendMessage).toHaveBeenCalledWith('automatic message', undefined, []);
    expect(wrapper.emitted('auto-sent')).toBeTruthy();
  });
});