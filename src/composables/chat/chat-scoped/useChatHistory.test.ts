import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEditMessage,
  mockEditMessageForChat,
  mockSwitchVersion,
  mockSwitchVersionForChat,
  mockForkChat,
  mockForkChatForChat,
  mockGetSiblings,
} = vi.hoisted(() => ({
  mockEditMessage: vi.fn(),
  mockEditMessageForChat: vi.fn(),
  mockSwitchVersion: vi.fn(),
  mockSwitchVersionForChat: vi.fn(),
  mockForkChat: vi.fn(),
  mockForkChatForChat: vi.fn(),
  mockGetSiblings: vi.fn(),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    editMessage: mockEditMessage,
    editMessageForChat: mockEditMessageForChat,
    switchVersion: mockSwitchVersion,
    switchVersionForChat: mockSwitchVersionForChat,
    forkChat: mockForkChat,
    forkChatForChat: mockForkChatForChat,
    getSiblings: mockGetSiblings,
  }),
}));

import { useChatHistory } from './useChatHistory';

describe('useChatHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockForkChat.mockResolvedValue('forked-chat');
    mockForkChatForChat.mockResolvedValue('forked-chat');
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

    expect(mockEditMessageForChat).not.toHaveBeenCalled();
    expect(mockSwitchVersionForChat).not.toHaveBeenCalled();
    expect(mockForkChat).toHaveBeenCalledWith({ messageId: 'message-1' });
    expect(mockForkChatForChat).not.toHaveBeenCalled();
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

    expect(mockEditMessageForChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'message-1',
      newContent: 'Updated',
      lmParameters: undefined,
    });
    expect(mockSwitchVersionForChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'message-1',
    });
    expect(mockForkChatForChat).toHaveBeenCalledWith({
      messageId: 'message-1',
      chatId: 'chat-1',
    });
    expect(mockForkChat).not.toHaveBeenCalled();
    expect(mockGetSiblings).toHaveBeenCalledWith({
      messageId: 'message-1',
      chatId: 'chat-1',
    });
  });
});
