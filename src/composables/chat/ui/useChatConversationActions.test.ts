import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSendMessage,
  mockSendMessageForChat,
  mockRegenerateMessage,
  mockRegenerateMessageForChat,
  mockAbortChat,
  mockEditMessage,
  mockEditMessageForChat,
  mockSwitchVersion,
  mockSwitchVersionForChat,
  mockForkChat,
  mockForkChatForChat,
  mockGetSiblings,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockSendMessageForChat: vi.fn(),
  mockRegenerateMessage: vi.fn(),
  mockRegenerateMessageForChat: vi.fn(),
  mockAbortChat: vi.fn(),
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
    sendMessage: mockSendMessage,
    sendMessageForChat: mockSendMessageForChat,
    regenerateMessage: mockRegenerateMessage,
    regenerateMessageForChat: mockRegenerateMessageForChat,
    abortChat: mockAbortChat,
    editMessage: mockEditMessage,
    editMessageForChat: mockEditMessageForChat,
    switchVersion: mockSwitchVersion,
    switchVersionForChat: mockSwitchVersionForChat,
    forkChat: mockForkChat,
    forkChatForChat: mockForkChatForChat,
    getSiblings: mockGetSiblings,
  }),
}));

import { useChatConversationActions } from './useChatConversationActions';

describe('useChatConversationActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue(false);
    mockSendMessageForChat.mockResolvedValue(true);
    mockForkChat.mockResolvedValue('forked-chat');
    mockForkChatForChat.mockResolvedValue('scoped-fork');
    mockGetSiblings.mockReturnValue([]);
  });

  it('uses scoped methods when they are available', async () => {
    const chatConversationActions = useChatConversationActions();

    await expect(chatConversationActions.sendMessage({
      chatId: 'chat-1',
      content: 'Hello',
      parentId: null,
      attachments: [],
      lmParameters: undefined,
    })).resolves.toBe(true);

    await chatConversationActions.regenerateMessage({
      chatId: 'chat-1',
      failedMessageId: 'assistant-1',
    });

    chatConversationActions.abortChat({
      chatId: 'chat-1',
    });

    await chatConversationActions.editMessage({
      chatId: 'chat-1',
      messageId: 'message-1',
      newContent: 'Updated',
      lmParameters: undefined,
    });

    await chatConversationActions.switchVersion({
      chatId: 'chat-1',
      messageId: 'message-1',
    });

    await expect(chatConversationActions.forkChat({
      chatId: 'chat-1',
      messageId: 'message-1',
    })).resolves.toBe('scoped-fork');

    expect(chatConversationActions.getSiblings({
      chatId: 'chat-1',
      messageId: 'message-1',
    })).toEqual([]);

    expect(mockSendMessageForChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      content: 'Hello',
      parentId: null,
      attachments: [],
      lmParameters: undefined,
    });
    expect(mockRegenerateMessageForChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      failedMessageId: 'assistant-1',
    });
    expect(mockAbortChat).toHaveBeenCalledWith({ chatId: 'chat-1' });
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
      chatId: 'chat-1',
      messageId: 'message-1',
    });
    expect(mockGetSiblings).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'message-1',
    });
  });

  it('falls back to legacy methods when scoped methods cannot be used', async () => {
    const chatConversationActions = useChatConversationActions();

    await expect(chatConversationActions.sendMessage({
      chatId: undefined,
      content: 'Hello',
      parentId: undefined,
      attachments: undefined,
      lmParameters: undefined,
    })).resolves.toBe(false);

    await chatConversationActions.regenerateMessage({
      chatId: undefined,
      failedMessageId: 'assistant-1',
    });

    await chatConversationActions.editMessage({
      chatId: undefined,
      messageId: 'message-1',
      newContent: 'Updated',
      lmParameters: undefined,
    });

    await chatConversationActions.switchVersion({
      chatId: undefined,
      messageId: 'message-1',
    });

    await expect(chatConversationActions.forkChat({
      chatId: undefined,
      messageId: 'message-1',
    })).resolves.toBe('forked-chat');

    expect(chatConversationActions.getSiblings({
      chatId: undefined,
      messageId: 'message-1',
    })).toEqual([]);

    expect(mockSendMessage).toHaveBeenCalledWith({
      content: 'Hello',
      parentId: undefined,
      attachments: undefined,
      chatTarget: undefined,
      lmParameters: undefined,
    });
    expect(mockRegenerateMessage).toHaveBeenCalledWith({
      failedMessageId: 'assistant-1',
    });
    expect(mockEditMessage).toHaveBeenCalledWith({
      messageId: 'message-1',
      newContent: 'Updated',
      lmParameters: undefined,
    });
    expect(mockSwitchVersion).toHaveBeenCalledWith({
      messageId: 'message-1',
    });
    expect(mockForkChat).toHaveBeenCalledWith({
      messageId: 'message-1',
    });
    expect(mockGetSiblings).toHaveBeenCalledWith({
      chatId: undefined,
      messageId: 'message-1',
    });
  });
});
