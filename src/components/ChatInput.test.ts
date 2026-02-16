import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ChatInput from './ChatInput.vue';
import { nextTick, ref } from 'vue';

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  Square: { template: '<span>Square</span>' },
  Minimize2: { template: '<span>Minimize2</span>' },
  Maximize2: { template: '<span>Maximize2</span>' },
  Send: { template: '<span>Send</span>' },
  Paperclip: { template: '<span>Paperclip</span>' },
  X: { template: '<span>X</span>' },
  Image: { template: '<span>Image</span>' },
  ChevronDown: { template: '<span>ChevronDown</span>' },
  ChevronUp: { template: '<span>ChevronUp</span>' },
  Edit2: { template: '<span>Edit2</span>' },
  FileEdit: { template: '<span>FileEdit</span>' },
}));

// Mock child components
vi.mock('./ModelSelector.vue', () => ({ default: { name: 'ModelSelector', template: '<div></div>' } }));
vi.mock('./ChatToolsMenu.vue', () => ({ default: { name: 'ChatToolsMenu', template: '<div></div>' } }));

// Mock composables
const mockCurrentChat = ref<any>({ id: 'chat-1', modelId: 'model-1' });
const mockSendMessage = vi.fn();

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    availableModels: ref([]),
    inheritedSettings: ref(null),
    fetchingModels: ref(false),
    isImageMode: vi.fn(() => false),
    toggleImageMode: vi.fn(),
    getResolution: vi.fn(() => ({ width: 512, height: 512 })),
    updateResolution: vi.fn(),
    getCount: vi.fn(() => 1),
    updateCount: vi.fn(),
    getPersistAs: vi.fn(() => 'original'),
    updatePersistAs: vi.fn(),
    setImageModel: vi.fn(),
    getSelectedImageModel: vi.fn(),
    fetchAvailableModels: vi.fn(),
    sendMessage: mockSendMessage,
  }),
}));

vi.mock('../composables/useChatDraft', () => ({
  useChatDraft: () => ({
    getDraft: vi.fn(() => ({ input: '', attachments: [], attachmentUrls: {} })),
    saveDraft: vi.fn(),
    clearDraft: vi.fn(),
    revokeAll: vi.fn(),
  }),
}));

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    activeFocusArea: ref('chat'),
    setActiveFocusArea: vi.fn(),
  }),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({
    currentRoute: { value: { query: {} } },
    replace: vi.fn(),
    push: vi.fn(),
  }),
}));

// Mock URL
global.URL.createObjectURL = vi.fn(() => 'blob:test');
global.URL.revokeObjectURL = vi.fn();

describe('ChatInput Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const getWrapper = () => mount(ChatInput, {
    props: {
      visibility: 'active',
      isStreaming: false,
      canGenerateImage: true,
      hasImageModel: true,
      availableImageModels: [],
      isAnimatingHeight: false
    },
    global: {
      stubs: {
        Teleport: true,
        ImageEditor: {
          name: 'ImageEditor',
          template: '<div data-testid="image-editor"><button class="apply-btn" @click="$emit(\'save\', { blob: {} })">Apply</button></div>',
          emits: ['save', 'cancel']
        }
      }
    }
  });

  it('should open ImageEditor when edit button is clicked', async () => {
    const wrapper = getWrapper();

    wrapper.vm.__testOnly.attachments.value = [{
      id: 'att-1',
      binaryObjectId: 'bin-1',
      originalName: 'test.png',
      mimeType: 'image/png',
      size: 100,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: new Blob()
    }];
    await nextTick();

    const editButton = wrapper.find('button[title="Edit Image"]');
    await editButton.trigger('click');

    await flushPromises();
    await nextTick();

    expect(wrapper.vm.__testOnly.editingAttachmentId.value).toBe('att-1');
    expect(wrapper.find('[data-testid="image-editor"]').exists()).toBe(true);
  });

  it('should update attachment and revoke old URL when ImageEditor saves', async () => {
    const wrapper = getWrapper();

    const originalBlob = new Blob(['original']);
    const originalBinId = 'bin-1';

    wrapper.vm.__testOnly.attachments.value = [{
      id: 'att-1',
      binaryObjectId: originalBinId,
      originalName: 'test.png',
      mimeType: 'image/png',
      size: 10,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: originalBlob
    }];
    await nextTick();

    // Trigger open
    wrapper.vm.__testOnly.editingAttachmentId.value = 'att-1';
    await nextTick();
    await flushPromises();
    await nextTick();

    // Simulate save from ImageEditor stub
    const editor = wrapper.find('[data-testid="image-editor"]');
    expect(editor.exists()).toBe(true);

    await editor.find('.apply-btn').trigger('click');
    await nextTick();

    const updatedAtt = wrapper.vm.__testOnly.attachments.value[0];
    expect(updatedAtt).toBeDefined();
    if (updatedAtt) {
      expect(updatedAtt.binaryObjectId).not.toBe(originalBinId);
    }
    expect(global.URL.revokeObjectURL).toHaveBeenCalled();
    expect(wrapper.vm.__testOnly.editingAttachmentId.value).toBeUndefined();
  });

  it('should handle attachment removal correctly', async () => {
    const wrapper = getWrapper();
    wrapper.vm.__testOnly.attachments.value = [
      { id: 'att-1', status: 'memory', blob: new Blob() } as any
    ];
    await nextTick();

    expect(wrapper.vm.__testOnly.attachments.value.length).toBe(1);

    const removeBtn = wrapper.find('button[title="Remove"]');
    await removeBtn.trigger('click');

    expect(wrapper.vm.__testOnly.attachments.value.length).toBe(0);
  });

  it('should clear attachments after successful message send', async () => {
    mockSendMessage.mockResolvedValue(true);
    const wrapper = getWrapper();
    wrapper.vm.input = 'test message';
    wrapper.vm.__testOnly.attachments.value = [
      { id: 'att-1', status: 'memory', blob: new Blob() } as any
    ];
    await nextTick();

    const sendBtn = wrapper.find('button[data-testid="send-button"]');
    await sendBtn.trigger('click');
    await flushPromises();

    expect(mockSendMessage).toHaveBeenCalled();
    expect(wrapper.vm.input).toBe('');
    expect(wrapper.vm.__testOnly.attachments.value.length).toBe(0);
  });
});
