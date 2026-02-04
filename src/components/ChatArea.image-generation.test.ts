import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { ref, computed, nextTick } from 'vue';
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
  toggleImageMode: vi.fn(() => { mockIsImageMode.value = !mockIsImageMode.value; }),
  getResolution: vi.fn(() => ({ width: 512, height: 512 })),
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
    await nextTick();
    
    // Check if Image icon exists instead of Send icon
    expect(wrapper.findComponent(Image).exists()).toBe(true);
  });

  it('calls sendImageRequest when sending a message in image mode', async () => {
    mockIsImageMode.value = true;
    
    const wrapper = mount(ChatArea);
    const textarea = wrapper.find('textarea');
    await textarea.setValue('a majestic mountain');
    
    const sendButton = wrapper.find('button.bg-blue-600'); // Send button
    await sendButton.trigger('click');
    
    expect(mockChatStore.sendImageRequest).toHaveBeenCalledWith({
      prompt: 'a majestic mountain',
      width: 512,
      height: 512
    });
  });

  it('can toggle image mode from the tools menu', async () => {
    const wrapper = mount(ChatArea);
    
    // Open menu
    const toolsButton = wrapper.find('[data-testid="chat-tools-button"]');
    await toolsButton.trigger('click');
    
    // Click toggle image mode
    const toggleButton = wrapper.find('[data-testid="toggle-image-mode-button"]');
    await toggleButton.trigger('click');
    
    expect(mockChatStore.toggleImageMode).toHaveBeenCalled();
    expect(mockIsImageMode.value).toBe(true);
  });

  it('switches send icon back to Send when image mode is disabled', async () => {
    // Start in image mode
    mockIsImageMode.value = true;
    const wrapper = mount(ChatArea);
    await nextTick();
    expect(wrapper.findComponent(Image).exists()).toBe(true);

    // Toggle off
    mockIsImageMode.value = false;
    await nextTick();
    
    expect(wrapper.findComponent(Image).exists()).toBe(false);
    expect(wrapper.findComponent(Send).exists()).toBe(true);
  });
});
