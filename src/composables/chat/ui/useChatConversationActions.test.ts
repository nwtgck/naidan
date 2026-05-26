import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSendMessageForChat,
  mockSendMessageToCurrentChat,
  mockRegenerateMessageForChat,
  mockRegenerateMessageForCurrentChat,
  mockEditMessageForChat,
  mockEditCurrentChatMessage,
  mockSwitchVersionForChat,
  mockSwitchVersionInCurrentChat,
  mockForkChatForChat,
  mockForkCurrentChat,
  mockGetSiblingsForChat,
  mockAbortTitleGenerationForChat,
  mockGetCurrentChatId,
  mockGetActiveContextCompaction,
  mockGetActiveGeneration,
  mockHasExternalGeneration,
  mockNotify,
} = vi.hoisted(() => ({
  mockSendMessageForChat: vi.fn(),
  mockSendMessageToCurrentChat: vi.fn(),
  mockRegenerateMessageForChat: vi.fn(),
  mockRegenerateMessageForCurrentChat: vi.fn(),
  mockEditMessageForChat: vi.fn(),
  mockEditCurrentChatMessage: vi.fn(),
  mockSwitchVersionForChat: vi.fn(),
  mockSwitchVersionInCurrentChat: vi.fn(),
  mockForkChatForChat: vi.fn(),
  mockForkCurrentChat: vi.fn(),
  mockGetSiblingsForChat: vi.fn(),
  mockAbortTitleGenerationForChat: vi.fn(),
  mockGetCurrentChatId: vi.fn(() => null),
  mockGetActiveContextCompaction: vi.fn(() => undefined),
  mockGetActiveGeneration: vi.fn(() => undefined),
  mockHasExternalGeneration: vi.fn(() => false),
  mockNotify: vi.fn(),
}));

vi.mock('@/services/storage', () => ({
  storageService: {
    notify: mockNotify,
  },
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  chatRuntimeStore: {
    activeGenerations: new Map(),
    getActiveGeneration: mockGetActiveGeneration,
    hasExternalGeneration: mockHasExternalGeneration,
  },
  contextCompactRuntime: {
    getActiveContextCompaction: mockGetActiveContextCompaction,
  },
}));

vi.mock('@/composables/chat/chat-scoped/chat-title-helpers', () => ({
  abortTitleGenerationForChat: mockAbortTitleGenerationForChat,
}));

vi.mock('@/composables/chat/chat-scoped/chat-generation-flow', () => ({
  sendMessageForChat: mockSendMessageForChat,
  sendMessageToCurrentChat: mockSendMessageToCurrentChat,
  regenerateMessageForChat: mockRegenerateMessageForChat,
  regenerateMessageForCurrentChat: mockRegenerateMessageForCurrentChat,
}));

vi.mock('@/composables/chat/chat-scoped/chat-history-flow', () => ({
  editMessageForChat: mockEditMessageForChat,
  editCurrentChatMessage: mockEditCurrentChatMessage,
  switchVersionForChat: mockSwitchVersionForChat,
  switchVersionInCurrentChat: mockSwitchVersionInCurrentChat,
  forkChatForChat: mockForkChatForChat,
  forkCurrentChat: mockForkCurrentChat,
  getSiblingsForChat: mockGetSiblingsForChat,
}));

vi.mock('./useChatUiServices', () => ({
  useChatUiServices: () => ({
    currentBridge: {
      getCurrentChatId: mockGetCurrentChatId,
    },
  }),
}));

import { useChatConversationActions } from './useChatConversationActions';

describe('useChatConversationActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessageForChat.mockResolvedValue(true);
    mockSendMessageToCurrentChat.mockResolvedValue(false);
    mockForkChatForChat.mockResolvedValue('scoped-fork');
    mockForkCurrentChat.mockResolvedValue('forked-chat');
    mockGetSiblingsForChat.mockReturnValue([]);
    mockGetCurrentChatId.mockReturnValue(null);
    mockGetActiveContextCompaction.mockReturnValue(undefined);
    mockGetActiveGeneration.mockReturnValue(undefined);
    mockHasExternalGeneration.mockReturnValue(false);
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
    expect(mockAbortTitleGenerationForChat).toHaveBeenCalledWith({ chatId: 'chat-1' });
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
    expect(mockGetSiblingsForChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'message-1',
    });
  });

  it('falls back to current-chat methods when chatId is undefined', async () => {
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

    expect(mockSendMessageToCurrentChat).toHaveBeenCalledWith({
      content: 'Hello',
      parentId: undefined,
      attachments: undefined,
      lmParameters: undefined,
    });
    expect(mockRegenerateMessageForCurrentChat).toHaveBeenCalledWith({
      failedMessageId: 'assistant-1',
    });
    expect(mockEditCurrentChatMessage).toHaveBeenCalledWith({
      messageId: 'message-1',
      newContent: 'Updated',
      lmParameters: undefined,
    });
    expect(mockSwitchVersionInCurrentChat).toHaveBeenCalledWith({
      messageId: 'message-1',
    });
    expect(mockForkCurrentChat).toHaveBeenCalledWith({
      messageId: 'message-1',
    });
    expect(mockGetSiblingsForChat).toHaveBeenCalledWith({
      chatId: undefined,
      messageId: 'message-1',
    });
  });
});
