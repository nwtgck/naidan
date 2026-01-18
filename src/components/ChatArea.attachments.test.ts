import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { ref, isRef, reactive } from 'vue';

// Define shared refs for the mock
const mockCurrentChat = ref({
  id: 'chat-1',
  title: 'Test Chat',
  root: { items: [] }
});
const mockActiveMessages = ref([]);
const mockStreaming = ref(false);

// Mock dependencies
vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    streaming: mockStreaming,
    activeGenerations: reactive(new Map()),
    activeMessages: mockActiveMessages,
    availableModels: ref([]),
    fetchingModels: ref(false),
    sendMessage: vi.fn(),
    isTyping: ref(false),
    error: ref(null),
    loadChat: vi.fn(),
    fetchAvailableModels: vi.fn().mockResolvedValue([]),
    saveChat: vi.fn(),
    moveChatToGroup: vi.fn(),
    chatGroups: ref([]),
  })
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
    currentRoute: { value: { params: { id: 'chat-1' } } }
  }),
  useRoute: () => ({
    params: { id: 'chat-1' }
  })
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({
      provider: 'ollama',
      ollama: {
        baseUrl: 'http://localhost:11434',
        model: 'llama3'
      }
    })
  })
}));

vi.mock('../composables/useToast', () => ({
  useToast: () => ({
    addToast: vi.fn()
  })
}));

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    canPersistBinary: true,
    saveFile: vi.fn().mockResolvedValue(undefined)
  }
}));

describe('ChatArea - Attachment UI', () => {
  it('should show preview when files are selected', async () => {
    // Reset refs for this test
    mockCurrentChat.value = {
      id: 'chat-1',
      title: 'Test Chat',
      root: { items: [] }
    } as any;
    mockActiveMessages.value = [];

    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true
        }
      }
    });

    // Directly set the internal attachments ref (now exposed via defineExpose)
    const attachments = (wrapper.vm as any).attachments;
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
      blob: testFile
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
    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true
        }
      }
    });

    const attachments = (wrapper.vm as any).attachments;
    const testFile = new File(['hello'], 'hello.png', { type: 'image/png' });
    
    const attachment = {
      id: 'att-1',
      originalName: 'hello.png',
      mimeType: 'image/png',
      size: 5,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: testFile
    };

    if (isRef(attachments)) {
      attachments.value = [attachment];
    } else {
      attachments.push(attachment);
    }

    // Ensure input or attachments exist to pass the guard
    (wrapper.vm as any).input = 'hello';
    mockStreaming.value = false;
    mockCurrentChat.value = { id: 'chat-1', title: 'T', root: { items: [] } } as any;

    // Trigger send
    await (wrapper.vm as any).handleSend();

    expect((wrapper.vm as any).attachments.length).toBe(0);
  });

  it('should remove attachment when remove button is clicked', async () => {
    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true
        }
      }
    });

    const attachments = (wrapper.vm as any).attachments;
    const attachment = {
      id: 'att-1',
      originalName: 'hello.png',
      mimeType: 'image/png',
      size: 5,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: new File([''], 'hello.png')
    };

    if (isRef(attachments)) {
      attachments.value = [attachment];
    } else {
      attachments.push(attachment);
    }

    await wrapper.vm.$nextTick();

    // Call removeAttachment
    (wrapper.vm as any).removeAttachment('att-1');
    await wrapper.vm.$nextTick();

    expect((wrapper.vm as any).attachments.length).toBe(0);
  });

  it('should handle image drop', async () => {
    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true
        }
      }
    });

    const testFile = new File(['hello'], 'hello.png', { type: 'image/png' });
    const dropEvent = {
      preventDefault: vi.fn(),
      dataTransfer: {
        files: [testFile]
      }
    };

    await wrapper.trigger('drop', dropEvent);
    
    // Check if attachment was added
    expect((wrapper.vm as any).attachments.length).toBe(1);
    expect((wrapper.vm as any).attachments[0].originalName).toBe('hello.png');
  });

  it('should show drag overlay when dragging over', async () => {
    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true
        }
      }
    });

    expect(wrapper.find('[data-testid="drag-overlay"]').exists()).toBe(false);

    await wrapper.trigger('dragover', {
      preventDefault: vi.fn(),
      currentTarget: wrapper.element
    });

    expect(wrapper.find('[data-testid="drag-overlay"]').exists()).toBe(true);

    await wrapper.trigger('dragleave', {
      clientX: -10, // Outside
      clientY: -10,
      currentTarget: wrapper.element
    });

    expect(wrapper.find('[data-testid="drag-overlay"]').exists()).toBe(false);
  });

  it('should handle image paste in textarea', async () => {
    const wrapper = mount(ChatArea, {
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true
        }
      }
    });

    const textarea = wrapper.find('[data-testid="chat-input"]');
    const testFile = new File(['hello'], 'pasted.png', { type: 'image/png' });
    
    // Create a mock ClipboardEvent
    const pasteEvent = {
      clipboardData: {
        items: [
          {
            type: 'image/png',
            getAsFile: () => testFile
          }
        ]
      }
    };

    await textarea.trigger('paste', pasteEvent);
    
    // Check if attachment was added
    expect((wrapper.vm as any).attachments.length).toBe(1);
    expect((wrapper.vm as any).attachments[0].originalName).toBe('pasted.png');
  });
});