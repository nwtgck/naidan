import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import ChatInput from './ChatInput.vue';
import { ref, nextTick } from 'vue';
import { Image, Send } from 'lucide-vue-next';


// Mock useChat singleton
const mockIsImageMode = ref(false);
const mockChatStore = {
  currentChat: ref({ id: 'chat-1', modelId: 'm1', root: { items: [] } }),
  streaming: ref(new Set()),
  generatingTitle: ref(false),
  activeMessages: ref([]),
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
};

vi.mock('../composables/useChat', () => ({
  useChat: vi.fn(() => mockChatStore)
}));

// Mock useRouter
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn()
  })
}));

describe('ChatArea Image Generation Integration', () => {
  beforeEach(() => {
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
    expect(wrapper.findComponent(Image).exists()).toBe(true);
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
    expect(wrapper.findComponent(Image).exists()).toBe(true);

    // Toggle off
    mockIsImageMode.value = false;
    await nextTick();

    expect(wrapper.findComponent(Image).exists()).toBe(false);
    expect(wrapper.findComponent(Send).exists()).toBe(true);
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
