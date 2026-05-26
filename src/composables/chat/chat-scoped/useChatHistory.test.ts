import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEditMessage,
  mockSwitchVersion,
  mockForkChat,
  mockGetSiblings,
} = vi.hoisted(() => ({
  mockEditMessage: vi.fn(),
  mockSwitchVersion: vi.fn(),
  mockForkChat: vi.fn(),
  mockGetSiblings: vi.fn(),
}));

vi.mock('@/composables/chat/ui/useChatConversationActions', () => ({
  useChatConversationActions: () => ({
    editMessage: mockEditMessage,
    switchVersion: mockSwitchVersion,
    forkChat: mockForkChat,
    getSiblings: mockGetSiblings,
  }),
}));

import { useChatHistory } from './useChatHistory';

describe('useChatHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockForkChat.mockResolvedValue('forked-chat');
    mockGetSiblings.mockReturnValue([]);
  });

  it('no-ops chat-bound operations when chatId is undefined', async () => {
    const chatHistory = useChatHistory({
      chatId: computed(() => undefined),
    });

    await expect(chatHistory.editMessage({
      messageId: 'message-1',
      newContent: 'Updated',
      lmParameters: undefined,
    })).resolves.toBeUndefined();

    await expect(chatHistory.switchVersion({
      messageId: 'message-1',
    })).resolves.toBeUndefined();

    await expect(chatHistory.forkChat({
      messageId: 'message-1',
    })).resolves.toBe('forked-chat');

    expect(chatHistory.getSiblings({
      messageId: 'message-1',
    })).toEqual([]);

    expect(mockForkChat).toHaveBeenCalledWith({ messageId: 'message-1', chatId: undefined });
    expect(mockGetSiblings).toHaveBeenCalledWith({
      messageId: 'message-1',
      chatId: undefined,
    });
  });

  it('binds history operations to the scoped chatId', async () => {
    const siblings = [{ id: 'assistant-1' }];
    mockGetSiblings.mockReturnValue(siblings);

    const chatHistory = useChatHistory({
      chatId: computed(() => 'chat-1'),
    });

    await expect(chatHistory.editMessage({
      messageId: 'message-1',
      newContent: 'Updated',
      lmParameters: undefined,
    })).resolves.toBeUndefined();

    await expect(chatHistory.switchVersion({
      messageId: 'message-1',
    })).resolves.toBeUndefined();

    await expect(chatHistory.forkChat({
      messageId: 'message-1',
    })).resolves.toBe('forked-chat');

    expect(chatHistory.getSiblings({
      messageId: 'message-1',
    })).toBe(siblings);

    expect(mockEditMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'message-1',
      newContent: 'Updated',
      lmParameters: undefined,
    });
    expect(mockSwitchVersion).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'message-1',
    });
    expect(mockForkChat).toHaveBeenCalledWith({
      messageId: 'message-1',
      chatId: 'chat-1',
    });
    expect(mockGetSiblings).toHaveBeenCalledWith({
      messageId: 'message-1',
      chatId: 'chat-1',
    });
  });
});
