import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import ChatInput from './ChatInput.vue';
import { ref, nextTick, computed } from 'vue';
import { ImageIcon, SendIcon } from 'lucide-vue-next';


import { setupScrollToMock } from '@/utils/test-utils';


// Mock useChat singleton
const mockIsImageMode = ref(false);
const mockActiveMessages = ref<any[]>([]);
const mockCurrentChatGroup = ref(null);

const mockChatStore = {
  currentChat: ref({ id: 'chat-1', modelId: 'm1', root: { items: [] } }),
  streaming: ref(new Set()),
  generatingTitle: ref(false),
  activeMessages: mockActiveMessages,
  fetchingModels: ref(false),
  availableModels: ref(['m1', 'x/z-image-turbo:v1']),
  resolvedSettings: ref({ endpointType: 'ollama', modelId: 'm1', sources: {} }),
  inheritedSettings: ref({ sources: {} }),
  isProcessing: vi.fn(() => false),
  isImageMode: vi.fn(() => mockIsImageMode.value),
  toggleImageMode: vi.fn(() => {
    mockIsImageMode.value = !mockIsImageMode.value;
  }),
  getResolution: vi.fn(() => ({ width: 512, height: 512 })),
  getCount: vi.fn(() => 1),
  updateCount: vi.fn(),
  getSteps: vi.fn(() => undefined),
  updateSteps: vi.fn(),
  getSeed: vi.fn(() => 'browser_random'),
  updateSeed: vi.fn(),  getPersistAs: vi.fn(() => 'original'),
  updatePersistAs: vi.fn(),
  imagePersistAsMap: ref({}),
  updateResolution: vi.fn(),
  setImageModel: vi.fn(),
  getSelectedImageModel: vi.fn(() => 'x/z-image-turbo:v1'),
  getSortedImageModels: vi.fn(() => ['x/z-image-turbo:v1']),
  sendImageRequest: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue(true),
  fetchAvailableModels: vi.fn(),
  updateChatModel: vi.fn(),
  openChat: vi.fn(),
  isTaskRunning: vi.fn(() => false),
  registerLiveInstance: vi.fn(),
  unregisterLiveInstance: vi.fn(),
  loadChats: vi.fn(),
  moveChatToGroup: vi.fn(),
  chatGroups: ref([]),
  toggleDebug: vi.fn(),
  abortChat: vi.fn(),
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
    isFirstInTurn: true
  }))),
  isThinkingActive: vi.fn(() => false),
  isWaitingResponse: vi.fn(() => false),
};
vi.mock('../composables/useChat', () => ({
  useChat: vi.fn(() => mockChatStore)
}));

vi.mock('../composables/chat/chat-scoped/useChatReadModel', () => ({
  useChatReadModel: () => ({
    currentChat: mockChatStore.currentChat,
    currentChatGroup: ref(null),
    activeMessages: mockActiveMessages,
    allMessages: computed(() => mockActiveMessages.value),
    resolvedSettings: mockChatStore.resolvedSettings,
    inheritedSettings: mockChatStore.inheritedSettings,
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatRuntime', () => ({
  useChatRuntime: () => ({
    isProcessing: computed(() => false),
    contextCompactProgress: ref({ phase: 'idle' }),
  }),
}));

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChat: computed(() => mockChatStore.currentChat.value),
    currentChatGroup: computed(() => mockCurrentChatGroup.value),
    currentChatId: computed(() => mockChatStore.currentChat.value?.id),
    activeMessages: computed(() => mockActiveMessages.value),
    allMessages: computed(() => mockActiveMessages.value),
    resolvedSettings: computed(() => mockChatStore.resolvedSettings.value),
    inheritedSettings: computed(() => mockChatStore.inheritedSettings.value),
    chatGroups: computed(() => []),
  }),
}));

vi.mock('../composables/chat/ui/useChatAreaData', () => ({
  useChatAreaData: () => ({
    updateChatSettings: vi.fn(),
    updateChatGroupMetadata: vi.fn(),
    availableModels: computed(() => mockChatStore.availableModels.value),
    fetchingModels: computed(() => false),
    getSortedImageModels: ({ availableModels }: { availableModels: string[] }) => availableModels,
    fetchAvailableModels: vi.fn(),
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
    availableChatGroups: computed(() => []),
  }),
}));

vi.mock('../composables/useChatDisplayFlow', () => ({
  useChatDisplayFlow: () => ({
    chatFlow: computed(() => mockChatStore.chatFlow.value),
    isThinkingActive: vi.fn(() => false),
    isWaitingResponse: vi.fn(() => false),
  }),
}));

vi.mock('../composables/chat/useChatModels', () => ({
  useChatModels: () => ({
    availableModels: mockChatStore.availableModels,
    fetchingModels: computed(() => false),
    fetchForChat: vi.fn(),
    fetchForGlobalEndpoint: vi.fn(),
    fetchForEndpoint: vi.fn(),
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
      content: string;
      parentId: string | null | undefined;
      attachments: unknown[] | undefined;
      lmParameters: unknown;
    }) => mockChatStore.sendMessage({
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
    availableModels: mockChatStore.availableModels,
    fetchingModels: computed(() => false),
    fetchModels: vi.fn(),
    updateModel: mockChatStore.updateChatModel,
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatReasoning', () => ({
  useChatReasoning: () => ({
    effort: computed(() => undefined),
    updateEffort: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatImageGeneration', () => ({
  useChatImageGeneration: () => ({
    availableModels: mockChatStore.availableModels,
    isImageMode: computed(() => mockIsImageMode.value),
    resolution: computed(() => ({ width: 512, height: 512 })),
    count: computed(() => mockChatStore.getCount()),
    persistAs: computed(() => 'original'),
    steps: computed(() => undefined),
    seed: computed(() => 'browser_random'),
    selectedImageModel: computed(() => 'x/z-image-turbo:v1'),
    toggleImageMode: () => mockChatStore.toggleImageMode(),
    updateResolution: vi.fn(),
    updateCount: vi.fn(),
    updatePersistAs: vi.fn(),
    updateSteps: vi.fn(),
    updateSeed: vi.fn(),
    setImageModel: vi.fn(),
    sendImageRequest: ({
      prompt,
      width,
      height,
      count,
      steps,
      seed,
      persistAs,
      attachments,
    }: {
      prompt: string;
      width: number;
      height: number;
      count: number;
      steps: number | undefined;
      seed: number | 'browser_random' | undefined;
      persistAs: 'original' | 'webp' | 'jpeg' | 'png';
      attachments: unknown[];
    }) => mockChatStore.sendImageRequest({
      prompt,
      width,
      height,
      count,
      steps,
      seed,
      persistAs,
      attachments,
    }),
  }),
}));

// Mock useRouter
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn()
  })
}));

describe('ChatArea Image Generation Integration', () => {
  beforeEach(() => {
    setupScrollToMock();
    vi.clearAllMocks();
    mockIsImageMode.value = false;
  });

  it('shows the image icon in the send button when in image mode', async () => {
    mockIsImageMode.value = true;

    const wrapper = mount(ChatArea);
    await flushPromises();
    await vi.dynamicImportSettled();
    await nextTick();

    // Check if Image icon exists instead of Send icon
    expect(wrapper.findComponent(ImageIcon).exists()).toBe(true);
  });

  it('calls sendImageRequest when sending a message in image mode', async () => {
    mockIsImageMode.value = true;

    const wrapper = mount(ChatArea);
    await flushPromises();
    await vi.dynamicImportSettled();

    const textarea = wrapper.find('textarea');
    await textarea.setValue('a majestic mountain');

    const sendButton = wrapper.find('button.bg-blue-600'); // Send button
    await sendButton.trigger('click');

    expect(mockChatStore.sendImageRequest).toHaveBeenCalledWith({
      prompt: 'a majestic mountain',
      width: 512,
      height: 512,
      count: 1,
      seed: 'browser_random',
      steps: undefined,
      persistAs: 'original',
      attachments: []
    });
  });

  it('calls sendImageRequest with attachments when images are attached', async () => {
    mockIsImageMode.value = true;

    const wrapper = mount(ChatArea);
    await flushPromises();
    await vi.dynamicImportSettled();

    const chatInput = wrapper.findComponent(ChatInput);
    const chatInputVm = chatInput.vm as any;

    const mockFile = new File(['test'], 'test.png', { type: 'image/png' });
    const mockAttachment = { id: 'att-1', originalName: 'test.png', mimeType: 'image/png', status: 'memory', blob: mockFile };

    chatInputVm.attachments = [mockAttachment];
    chatInputVm.input = 'remix this';
    await nextTick();

    const sendButton = wrapper.find('[data-testid="send-button"]');
    await sendButton.trigger('click');

    expect(mockChatStore.sendImageRequest).toHaveBeenCalledWith({
      prompt: 'remix this',
      width: 512,
      height: 512,
      count: 1,
      seed: 'browser_random',
      steps: undefined,
      persistAs: 'original',
      attachments: expect.arrayContaining([expect.objectContaining({ id: 'att-1' })])
    });

    // Check if attachments are cleared after success
    await nextTick();
    expect(chatInputVm.attachments).toHaveLength(0);
  });

  it('can toggle image mode from the tools menu', async () => {
    const wrapper = mount(ChatArea);
    await flushPromises();
    await vi.dynamicImportSettled();

    // Open menu
    const toolsButton = wrapper.find('[data-testid="chat-tools-button"]');
    await toolsButton.trigger('click');
    await flushPromises();
    await vi.dynamicImportSettled();

    // Click toggle image mode
    const toggleButton = document.body.querySelector('[data-testid="toggle-image-mode-button"]') as HTMLElement;
    toggleButton.click();

    expect(mockChatStore.toggleImageMode).toHaveBeenCalled();
    expect(mockIsImageMode.value).toBe(true);
  });

  it('switches send icon back to Send when image mode is disabled', async () => {
    // Start in image mode
    mockIsImageMode.value = true;
    const wrapper = mount(ChatArea);
    await flushPromises();
    await vi.dynamicImportSettled();
    await nextTick();
    expect(wrapper.findComponent(ImageIcon).exists()).toBe(true);

    // Toggle off
    mockIsImageMode.value = false;
    await nextTick();

    expect(wrapper.findComponent(ImageIcon).exists()).toBe(false);
    expect(wrapper.findComponent(SendIcon).exists()).toBe(true);
  });

  it('passes the requested image count to sendImageRequest', async () => {
    mockIsImageMode.value = true;
    mockChatStore.getCount.mockReturnValue(3); // User requested 3 images

    const wrapper = mount(ChatArea);
    await flushPromises();
    await vi.dynamicImportSettled();

    const textarea = wrapper.find('textarea');
    await textarea.setValue('a futuristic city');

    const sendButton = wrapper.find('[data-testid="send-button"]');
    await sendButton.trigger('click');

    expect(mockChatStore.sendImageRequest).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a futuristic city',
      count: 3,
      persistAs: 'original'
    }));
  });
});
