import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import ChatPrintContent from './ChatPrintContent.vue';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { useChatHistory } from '@/composables/chat/chat-scoped/useChatHistory';

// Mock dependencies
const mockMarkPrintReady = vi.fn();
vi.mock('../composables/usePrint', () => ({
  usePrint: () => ({
    markPrintReady: mockMarkPrintReady,
  }),
}));

const mockCurrentChat = ref<any>({
  id: 'chat_123',
  title: 'Test Chat Title'
});
const mockActiveMessages = ref<any[]>([
  { id: 'msg_1', role: 'user', content: 'Hello' },
  { id: 'msg_2', role: 'assistant', content: 'World' }
]);

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: vi.fn(),
}));

vi.mock('../composables/chat/chat-scoped/useChatHistory', () => ({
  useChatHistory: vi.fn(),
}));

// Mock MessageItem to avoid complex rendering
vi.mock('./MessageItem.vue', () => ({
  default: {
    name: 'MessageItem',
    props: ['message'],
    template: '<div class="mock-message-item">{{ message.content }}</div>'
  }
}));

describe('ChatPrintContent component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCurrentChatState).mockReturnValue({
      currentChat: computed(() => mockCurrentChat.value),
      currentChatId: computed(() => mockCurrentChat.value?.id),
      activeMessages: computed(() => mockActiveMessages.value),
      currentChatGroup: computed(() => null),
      allMessages: computed(() => mockActiveMessages.value),
      resolvedSettings: computed(() => null),
      inheritedSettings: computed(() => null),
      chatGroups: computed(() => []),
      TEST_ONLY: {},
    } as ReturnType<typeof useCurrentChatState>);
    vi.mocked(useChatHistory).mockReturnValue({
      editMessage: vi.fn(),
      switchVersion: vi.fn(),
      forkChat: vi.fn(),
      getSiblings: vi.fn(() => []),
      TEST_ONLY: {},
    } as unknown as ReturnType<typeof useChatHistory>);
  });

  it('should call markPrintReady when mounted', () => {
    mount(ChatPrintContent);
    expect(mockMarkPrintReady).toHaveBeenCalled();
  });

  it('should render the chat title and messages', () => {
    const wrapper = mount(ChatPrintContent);

    // Check title
    expect(wrapper.find('h1').text()).toBe('Test Chat Title');

    // Check message rendering
    const messages = wrapper.findAll('.mock-message-item');
    expect(messages.length).toBe(2);
    expect(messages[0]!.text()).toBe('Hello');
    expect(messages[1]!.text()).toBe('World');
  });

  it('should render chat ID in header', () => {
    const wrapper = mount(ChatPrintContent);
    expect(wrapper.find('p').text()).toContain('CHAT ID: chat_123');
  });

  it('should handle empty chat title', () => {
    mockCurrentChat.value.title = '';
    const wrapper = mount(ChatPrintContent);
    expect(wrapper.find('h1').text()).toBe('Chat History');
  });
});
