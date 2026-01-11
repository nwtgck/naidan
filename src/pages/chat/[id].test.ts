import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive, nextTick } from 'vue';
import ChatPage from './[id].vue';
import { useChat } from '../../composables/useChat';
import { useRoute } from 'vue-router';

vi.mock('../../composables/useChat', () => ({
  useChat: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRoute: vi.fn(),
}));

vi.mock('../../components/ChatArea.vue', () => ({
  default: {
    name: 'ChatArea',
    template: '<div data-testid="chat-area"></div>',
  },
}));

describe('ChatPage', () => {
  const mockOpenChat = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useChat as unknown as Mock).mockReturnValue({
      openChat: mockOpenChat,
    });
  });

  it('calls openChat on mount with id from route', () => {
    (useRoute as unknown as Mock).mockReturnValue({
      params: reactive({ id: 'chat-123' }),
    });
    
    mount(ChatPage);
    expect(mockOpenChat).toHaveBeenCalledWith('chat-123');
  });

  it('watches route.params.id and calls openChat', async () => {
    const params = reactive({ id: 'chat-123' });
    (useRoute as unknown as Mock).mockReturnValue({ params });
    
    mount(ChatPage);
    expect(mockOpenChat).toHaveBeenCalledWith('chat-123');
    
    params.id = 'chat-456';
    await nextTick();
    expect(mockOpenChat).toHaveBeenCalledWith('chat-456');
  });
});
