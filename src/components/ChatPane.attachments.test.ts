import type { ChatId, MessageId } from '@/models/ids';
import { toChatId } from '@/models/ids';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatPane from './ChatPane.vue';
import ChatInput from './ChatInput.vue';
import { ref, isRef, reactive, computed } from 'vue';
import { useChatDraft } from '@/composables/useChatDraft';
import { setupScrollToMock } from '@/utils/test-utils';

// Define shared refs for the mock
const mockCurrentChat = ref({
  id: toChatId({ raw: 'chat-1' }),
  title: 'Test Chat',
  root: { items: [] },
});
const mockActiveMessages = ref<any[]>([]);
const mockChatGroups = ref<any[]>([]);
const mockResolvedSettings = ref<any>({ modelId: 'm1', sources: { modelId: 'global' } });
const mockInheritedSettings = ref<any>({ modelId: 'm1', sources: { modelId: 'global' } });
const mockStreaming = ref(false);
const mockSendMessage = vi.fn().mockResolvedValue(true);

// Mock dependencies
vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    streaming: mockStreaming,
    activeGenerations: reactive(new Map()),
    activeMessages: mockActiveMessages,
    availableModels: ref([]),
    fetchingModels: ref(false),
    sendMessage: mockSendMessage,
    isTyping: ref(false),
    error: ref(null),
    loadChat: vi.fn(),
    fetchAvailableModels: vi.fn().mockResolvedValue([]),
    saveChat: vi.fn(),
    generateChatTitle: vi.fn(),
    abortTitleGeneration: vi.fn(),
    moveChatToGroup: vi.fn(),
    chatGroups: mockChatGroups,
    resolvedSettings: mockResolvedSettings,
    inheritedSettings: mockInheritedSettings,
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
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
    getSortedImageModels: vi.fn(() => []),
    imageModeMap: ref({}),
    imageResolutionMap: ref({}),
    imageCountMap: ref({}),
    imagePersistAsMap: ref({}),
    imageModelOverrideMap: ref({}),
    getReasoningEffort: vi.fn(),
    updateReasoningEffort: vi.fn(),
    updateChatSettings: vi.fn(),
    getLiveChat: vi.fn().mockImplementation((c) => c),
    chatFlow: computed(() => mockActiveMessages.value.map(m => ({
      type: 'message',
      node: m,
      mode: 'content',
      flow: { position: 'standalone', nesting: 'none' },
      isFirstInNode: true,
      isLastInNode: true,
      isFirstInTurn: true,
    }))),
    isThinkingActive: vi.fn(() => false),
    isWaitingResponse: vi.fn(() => false),
  }),
}));


vi.mock('../composables/chat/ui/useChatPaneState', () => ({
  useChatPaneState: () => ({
    chat: computed(() => mockCurrentChat.value),
    chatGroup: computed(() => null),
    activeMessages: computed(() => mockActiveMessages.value),
    allMessages: computed(() => mockActiveMessages.value),
    resolvedSettings: computed(() => mockResolvedSettings.value),
    inheritedSettings: computed(() => mockInheritedSettings.value),
    chatGroups: computed(() => mockChatGroups.value),
  }),
}));


function mountChatPane({
  props,
  attachTo,
  global,
}: {
  props?: {
    chatId?: ChatId,
    autoSendPrompt?: string,
    targetMessageId?: MessageId,
  },
  attachTo?: Element | string,
  global?: Record<string, unknown>,
} = {}) {
  return mount(ChatPane, {
    props: {
      chatId: props?.chatId ?? mockCurrentChat.value?.id ?? toChatId({ raw: '1' }),
      autoSendPrompt: props?.autoSendPrompt,
      targetMessageId: props?.targetMessageId,
    },
    attachTo,
    global,
  });
}

vi.mock('../composables/chat/useChatConversation', () => ({
  useChatConversation: () => ({
    sendMessage: ({
      content,
      parentId,
      attachments,
      lmParameters,
    }: {
      chatId: string,
      content: string,
      parentId: string | null | undefined,
      attachments: unknown[] | undefined,
      lmParameters: unknown,
    }) => mockSendMessage({
      content,
      parentId,
      attachments: attachments ?? [],
      chatTarget: undefined,
      lmParameters,
    }),
    regenerateMessage: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatModels', () => ({
  useChatModels: () => ({
    availableModels: ref([]),
    fetchingModels: computed(() => false),
    fetchForChat: vi.fn(),
    fetchForGlobalEndpoint: vi.fn(),
    fetchForEndpoint: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatMounts', () => ({
  useChatMounts: () => ({
    getMounts: () => computed(() => []),
    addMount: vi.fn(),
    removeMount: vi.fn(),
    updateMount: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatMetadata', () => ({
  useChatMetadata: () => ({
    reasoningEffort: () => computed(() => undefined),
    updateReasoningEffort: vi.fn(),
    updateModel: vi.fn(),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatGeneration', () => ({
  useChatGeneration: () => ({
    sendMessage: ({
      content,
      parentId,
      attachments,
      lmParameters,
    }: {
      content: string,
      parentId: string | null | undefined,
      attachments: unknown[] | undefined,
      lmParameters: unknown,
    }) => mockSendMessage({
      content,
      parentId,
      attachments: attachments ?? [],
      chatTarget: undefined,
      lmParameters,
    }),
    regenerateMessage: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatModelSelection', () => ({
  useChatModelSelection: () => ({
    availableModels: ref([]),
    fetchingModels: computed(() => false),
    fetchModels: vi.fn(),
    updateModel: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatImageGeneration', () => ({
  useChatImageGeneration: () => ({
    availableModels: ref([]),
    isImageMode: computed(() => false),
    resolution: computed(() => ({ width: 512, height: 512 })),
    count: computed(() => 1),
    persistAs: computed(() => 'original'),
    steps: computed(() => undefined),
    seed: computed(() => 'browser_random'),
    selectedImageModel: computed(() => undefined),
    toggleImageMode: vi.fn(),
    updateResolution: vi.fn(),
    updateCount: vi.fn(),
    updatePersistAs: vi.fn(),
    updateSteps: vi.fn(),
    updateSeed: vi.fn(),
    setImageModel: vi.fn(),
    sendImageRequest: vi.fn().mockResolvedValue(true),
  }),
}));

vi.mock('../composables/chat/useChatImageProgress', () => ({
  useChatImageProgress: () => ({
    progress: computed(() => undefined),
    currentStep: computed(() => undefined),
    totalSteps: computed(() => undefined),
  }),
}));


vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
    currentRoute: { value: { params: { id: toChatId({ raw: 'chat-1' }) } } },
  }),
  useRoute: () => ({
    params: { id: toChatId({ raw: 'chat-1' }) },
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({
      provider: 'ollama',
      ollama: {
        baseUrl: 'http://localhost:11434',
        model: 'llama3',
      },
    }),
  }),
}));

vi.mock('../composables/useToast', () => ({
  useToast: () => ({
    addToast: vi.fn(),
  }),
}));

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => { }),
    canPersistBinary: true,
    saveFile: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
  },
}));

describe('ChatPane - Attachment UI', () => {
  beforeEach(() => {
    setupScrollToMock();
    const { clearAllDrafts } = useChatDraft();
    clearAllDrafts();
  });
  it('should show preview when files are selected', async () => {
    // Reset refs for this test
    mockCurrentChat.value = {
      id: toChatId({ raw: 'chat-1' }),
      title: 'Test Chat',
      root: { items: [] },
    } as any;
    mockActiveMessages.value = [];

    const wrapper = mountChatPane( {
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true,
        },
      },
    });

    // Directly set the internal attachments ref
    const chatInput = wrapper.findComponent(ChatInput);
    const attachments = (chatInput.vm as any).attachments;
    expect(attachments).toBeDefined();

    const testFile = new File(['hello'], 'hello.png', { type: 'image/png' });
    global.URL.createObjectURL = vi.fn().mockReturnValue('mock-url');

    const attachment = {
      id: 'att-1',
      originalName: 'hello.png',
      mimeType: 'image/png',
      size: 5,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: testFile,
    };

    if (isRef(attachments)) {
      attachments.value = [attachment];
    } else {
      // If it's unwrapped by Vue Test Utils/Vue
      attachments.push(attachment);
    }

    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    // Check for the preview container
    expect(wrapper.find('[data-testid="attachment-preview"]').exists()).toBe(true);
  });

  it('should clear attachments when message is sent', async () => {
    const wrapper = mountChatPane( {
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true,
        },
      },
    });

    const chatInput = wrapper.findComponent(ChatInput);
    const attachments = (chatInput.vm as any).attachments;
    const testFile = new File(['hello'], 'hello.png', { type: 'image/png' });

    const attachment = {
      id: 'att-1',
      originalName: 'hello.png',
      mimeType: 'image/png',
      size: 5,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: testFile,
    };

    if (isRef(attachments)) {
      attachments.value = [attachment];
    } else {
      attachments.push(attachment);
    }

    // Ensure input or attachments exist to pass the guard
    (chatInput.vm as any).input = 'hello';
    mockStreaming.value = false;
    mockCurrentChat.value = { id: toChatId({ raw: 'chat-1' }), title: 'T', root: { items: [] } } as any;

    // Trigger send
    await (chatInput.vm as any).handleSend();

    expect((chatInput.vm as any).attachments.length).toBe(0);
  });

  it('should remove attachment when remove button is clicked', async () => {
    const wrapper = mountChatPane( {
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true,
        },
      },
    });

    const chatInput = wrapper.findComponent(ChatInput);
    const attachments = (chatInput.vm as any).attachments;
    const attachment = {
      id: 'att-1',
      originalName: 'hello.png',
      mimeType: 'image/png',
      size: 5,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: new File([''], 'hello.png'),
    };

    if (isRef(attachments)) {
      attachments.value = [attachment];
    } else {
      attachments.push(attachment);
    }

    await wrapper.vm.$nextTick();

    // Call removeAttachment
    (chatInput.vm as any).removeAttachment({ id: 'att-1' });
    await wrapper.vm.$nextTick();

    expect((chatInput.vm as any).attachments.length).toBe(0);
  });

  it('should handle image drop', async () => {
    const wrapper = mountChatPane( {
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true,
        },
      },
    });

    const testFile = new File(['hello'], 'hello.png', { type: 'image/png' });
    const dropEvent = {
      preventDefault: vi.fn(),
      dataTransfer: {
        items: [
          {
            kind: 'file',
            webkitGetAsEntry: () => ({
              isFile: true,
              isDirectory: false,
              name: 'hello.png',
              file: (cb: (f: File) => void) => cb(testFile),
            }),
          },
        ],
      },
    };

    await wrapper.trigger('drop', dropEvent);

    // Check if attachment was added
    const chatInput = wrapper.findComponent(ChatInput);
    expect((chatInput.vm as any).attachments.length).toBe(1);
    expect((chatInput.vm as any).attachments[0].originalName).toBe('hello.png');
  });

  it('should show drag overlay when dragging over', async () => {
    const wrapper = mountChatPane( {
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true,
        },
      },
    });

    expect(wrapper.find('[data-testid="drag-overlay"]').exists()).toBe(false);

    await wrapper.trigger('dragover', {
      preventDefault: vi.fn(),
      currentTarget: wrapper.element,
    });

    expect(wrapper.find('[data-testid="drag-overlay"]').exists()).toBe(true);

    await wrapper.trigger('dragleave', {
      clientX: -10, // Outside
      clientY: -10,
      currentTarget: wrapper.element,
    });

    expect(wrapper.find('[data-testid="drag-overlay"]').exists()).toBe(false);
  });

  it('should handle image paste in textarea', async () => {
    const wrapper = mountChatPane( {
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true,
        },
      },
    });

    const textarea = wrapper.find('[data-testid="chat-input"]');
    const testFile = new File(['hello'], 'pasted.png', { type: 'image/png' });

    // Create a mock ClipboardEvent
    const pasteEvent = {
      clipboardData: {
        items: [
          {
            type: 'image/png',
            getAsFile: () => testFile,
          },
        ],
      },
    };

    await textarea.trigger('paste', pasteEvent);

    // Check if attachment was added
    const chatInput = wrapper.findComponent(ChatInput);
    expect((chatInput.vm as any).attachments.length).toBe(1);
    expect((chatInput.vm as any).attachments[0].originalName).toBe('pasted.png');
  });
});
