import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import ChatPage from './[id].vue';
import { useChat } from '@/composables/useChat';
import { useRouter } from 'vue-router';

vi.mock('../../composables/useChat', () => ({
  useChat: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
}));

vi.mock('../../components/ChatArea.vue', () => ({
  default: {
    name: 'ChatArea',
    props: ['targetMessageId'],
    template: '<div data-testid="chat-area"></div>',
  },
}));

describe('ChatPage', () => {
  const mockOpenChat = vi.fn();
  const mockOpenChatAtMessage = vi.fn();
  const mockRouter = {
    currentRoute: ref({
      params: { id: 'chat-123' },
      query: {},
    }),
    replace: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useChat as unknown as Mock).mockReturnValue({
      openChat: mockOpenChat,
      openChatAtMessage: mockOpenChatAtMessage,
    });
    (useRouter as unknown as Mock).mockReturnValue(mockRouter);
  });

  it('calls openChat on mount with id from route', () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: {},
    };

    mount(ChatPage);
    expect(mockOpenChat).toHaveBeenCalledWith('chat-123', undefined);
  });

  it('watches route.params.id and calls openChat', async () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: {},
    };

    mount(ChatPage);
    expect(mockOpenChat).toHaveBeenCalledWith('chat-123', undefined);

    mockRouter.currentRoute.value = {
      params: { id: 'chat-456' },
      query: {},
    };
    await nextTick();
    expect(mockOpenChat).toHaveBeenCalledWith('chat-456', undefined);
  });

  it('watches leaf query parameter and calls openChat', async () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: { leaf: 'leaf-1' },
    };

    mount(ChatPage);
    expect(mockOpenChat).toHaveBeenCalledWith('chat-123', 'leaf-1');

    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: { leaf: 'leaf-2' },
    };
    await nextTick();
    expect(mockOpenChat).toHaveBeenCalledWith('chat-123', 'leaf-2');
  });

  it('watches message-id query parameter and opens at that message', async () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: { 'message-id': 'message-1' },
    };

    mount(ChatPage);
    expect(mockOpenChatAtMessage).toHaveBeenCalledWith({ chatId: 'chat-123', messageId: 'message-1' });
    expect(mockOpenChat).not.toHaveBeenCalled();

    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: { 'message-id': 'message-2' },
    };
    await nextTick();
    expect(mockOpenChatAtMessage).toHaveBeenCalledWith({ chatId: 'chat-123', messageId: 'message-2' });
  });

  it('passes message-id query parameter to ChatArea as the target message', () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: { 'message-id': 'message-1' },
    };

    const wrapper = mount(ChatPage);

    expect(wrapper.findComponent({ name: 'ChatArea' }).props('targetMessageId')).toBe('message-1');
  });

  it('prefers message-id over leaf when both query parameters are present', () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: { leaf: 'leaf-1', 'message-id': 'message-1' },
    };

    mount(ChatPage);
    expect(mockOpenChatAtMessage).toHaveBeenCalledWith({ chatId: 'chat-123', messageId: 'message-1' });
    expect(mockOpenChat).not.toHaveBeenCalled();
  });
});
