import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import ChatPage from './[id].vue';
import { useChat } from '../../composables/useChat';
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
    template: '<div data-testid="chat-area"></div>',
  },
}));

describe('ChatPage', () => {
  const mockOpenChat = vi.fn();
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
    });
    (useRouter as unknown as Mock).mockReturnValue(mockRouter);
  });

  it('calls openChat on mount with id from route', () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: {},
    };
    
    mount(ChatPage);
    expect(mockOpenChat).toHaveBeenCalledWith('chat-123');
  });

  it('watches route.params.id and calls openChat', async () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: {},
    };
    
    mount(ChatPage);
    expect(mockOpenChat).toHaveBeenCalledWith('chat-123');
    
    mockRouter.currentRoute.value = {
      params: { id: 'chat-456' },
      query: {},
    };
    await nextTick();
    expect(mockOpenChat).toHaveBeenCalledWith('chat-456');
  });
});