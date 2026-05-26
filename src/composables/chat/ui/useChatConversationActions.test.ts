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
  mockGenerateChatTitle,
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
  mockGenerateChatTitle: vi.fn(),
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

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: {
      value: {
        storageType: 'opfs',
      },
    },
  }),
}));

vi.mock('@/composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: vi.fn(),
  }),
}));

vi.mock('@/composables/useChatTools', () => ({
  useChatTools: () => ({
    enabledToolNames: { value: [] },
  }),
}));

vi.mock('@/composables/useChatWeshPreferences', () => ({
  useChatWeshPreferences: () => ({
    getNaidanSysfsMountSelection: vi.fn(() => 'none'),
  }),
}));

vi.mock('@/composables/useImageGeneration', () => ({
  useImageGeneration: () => ({
    isImageMode: vi.fn(() => false),
    getSelectedImageModel: vi.fn(),
    getResolution: vi.fn(() => ({ width: 512, height: 512 })),
    getCount: vi.fn(() => 1),
    getSteps: vi.fn(() => undefined),
    getSeed: vi.fn(() => undefined),
    getPersistAs: vi.fn(() => 'original'),
    performBase64Generation: vi.fn(),
    handleImageGeneration: vi.fn(),
    sendImageRequest: vi.fn(),
  }),
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: vi.fn(),
  }),
}));

vi.mock('@/composables/useStoragePersistence', () => ({
  useStoragePersistence: () => ({
    requestPersistence: vi.fn(),
  }),
}));

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    addToast: vi.fn(),
  }),
}));

vi.mock('@/services/storage', () => ({
  storageService: {
    canPersistBinary: true,
    saveFile: vi.fn(),
    getFile: vi.fn(),
    notify: vi.fn(),
    loadChatGroup: vi.fn(),
    updateHierarchy: vi.fn(),
  },
}));

vi.mock('@/services/tools/factory', () => ({
  getEnabledTools: vi.fn(async () => []),
}));

vi.mock('@/services/wesh/mount-policy', () => ({
  shouldIncludeWritableTmpMount: vi.fn(() => false),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  chatRuntimeStore: {
    activeGenerations: new Map(),
    hasExternalGeneration: vi.fn(() => false),
    getActiveGeneration: vi.fn(),
    startTask: vi.fn(),
    finishTask: vi.fn(),
  },
  chatVolatileState: {
    setVolatileAssistantError: vi.fn(),
    clearVolatileAssistantError: vi.fn(),
    setVolatileToolOutput: vi.fn(),
    appendVolatileToolOutput: vi.fn(),
    deleteVolatileToolOutput: vi.fn(),
  },
  contextCompactRuntime: {
    getActiveContextCompaction: vi.fn(),
  },
  currentChatGroupRef: { value: null },
  currentChatRef: { value: null },
  ensureChatTmpDirectory: vi.fn(),
  getLiveChat: vi.fn(({ chat }) => chat),
  isProcessing: vi.fn(() => false),
  liveChatRegistry: new Map(),
  loadData: vi.fn(),
  registerLiveInstance: vi.fn(),
  updateChatContent: vi.fn(),
  updateChatMeta: vi.fn(),
}));

vi.mock('@/composables/chat/services/chat-title-service', () => ({
  createChatTitleService: () => ({
    generateChatTitle: mockGenerateChatTitle,
    abortTitleGeneration: mockAbortChat,
  }),
}));

vi.mock('@/composables/chat/services/chat-image-service', () => ({
  createChatImageService: () => ({
    handleImageGeneration: vi.fn(),
  }),
}));

vi.mock('@/composables/chat/services/chat-generation-service', () => ({
  createChatGenerationService: () => ({
    sendMessage: mockSendMessage,
    sendMessageForChat: mockSendMessageForChat,
    generateResponse: vi.fn(),
  }),
}));

vi.mock('@/composables/chat/services/chat-history-service', () => ({
  createChatHistoryService: () => ({
    forkChat: mockForkChat,
    forkChatForChat: mockForkChatForChat,
    editMessage: mockEditMessage,
    editMessageForChat: mockEditMessageForChat,
    switchVersion: mockSwitchVersion,
    switchVersionForChat: mockSwitchVersionForChat,
    getSiblings: mockGetSiblings,
  }),
}));

vi.mock('@/composables/chat/services/chat-regeneration-service', () => ({
  createChatRegenerationService: () => ({
    regenerateMessage: mockRegenerateMessage,
    regenerateMessageForChat: mockRegenerateMessageForChat,
  }),
}));

vi.mock('./useChatUiServices', () => ({
  useChatUiServices: () => ({
    availableModels: { value: [] },
    currentBridge: {
      getCurrentChat: vi.fn(() => null),
      getCurrentChatId: vi.fn(() => null),
      getChatTargetByOptionalId: vi.fn(() => null),
      getChatTargetById: vi.fn(() => null),
      triggerCurrentChat: vi.fn(),
    },
    derivedState: {
      chatGroups: { value: [] },
    },
    hierarchyService: {
      reorderSidebarChatAfterSend: vi.fn(),
    },
    modelService: {
      fetchAvailableModels: vi.fn(async () => []),
    },
    openService: {
      openChat: vi.fn(),
    },
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
