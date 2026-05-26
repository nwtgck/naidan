import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAvailableModels,
  mockFetchingModels,
  mockMoveChatToGroup,
  mockToggleDebug,
  mockToggleDebugForChat,
  mockRenameChat,
  mockGenerateChatTitle,
  mockAbortTitleGeneration,
  mockIsGeneratingTitle,
  mockUpdateChatSettings,
  mockUpdateChatModel,
  mockFetchAvailableModels,
  mockCommitFullHistoryManipulation,
} = vi.hoisted(() => ({
  mockAvailableModels: { value: ['model-a'] },
  mockFetchingModels: { value: false },
  mockMoveChatToGroup: vi.fn().mockResolvedValue(undefined),
  mockToggleDebug: vi.fn().mockResolvedValue(undefined),
  mockToggleDebugForChat: vi.fn().mockResolvedValue(undefined),
  mockRenameChat: vi.fn().mockResolvedValue(undefined),
  mockGenerateChatTitle: vi.fn().mockResolvedValue('Generated'),
  mockAbortTitleGeneration: vi.fn(),
  mockIsGeneratingTitle: vi.fn().mockReturnValue(false),
  mockUpdateChatSettings: vi.fn().mockResolvedValue(undefined),
  mockUpdateChatModel: vi.fn().mockResolvedValue(undefined),
  mockFetchAvailableModels: vi.fn().mockResolvedValue(['model-a']),
  mockCommitFullHistoryManipulation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: {
      value: {},
    },
  }),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  chatRuntimeStore: {},
  currentChatRef: { value: null },
  fetchingModels: mockFetchingModels,
  getLiveChat: vi.fn(({ chat }) => chat),
  isGeneratingTitle: mockIsGeneratingTitle,
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
    abortTitleGeneration: mockAbortTitleGeneration,
  }),
}));

vi.mock('@/composables/chat/services/chat-history-service', () => ({
  createChatHistoryService: () => ({
    commitFullHistoryManipulation: mockCommitFullHistoryManipulation,
  }),
}));

vi.mock('./useChatUiServices', () => ({
  useChatUiServices: () => ({
    availableModels: mockAvailableModels,
    currentBridge: {
      getCurrentChatId: vi.fn(),
      getChatTargetByOptionalId: vi.fn(),
      triggerCurrentChat: vi.fn(),
    },
    derivedState: {
      chatGroups: { value: [] },
    },
    hierarchyService: {
      moveChatToGroup: mockMoveChatToGroup,
    },
    metadataService: {
      toggleDebug: mockToggleDebug,
      toggleDebugForChat: mockToggleDebugForChat,
      renameChat: mockRenameChat,
      updateChatSettings: mockUpdateChatSettings,
      updateChatModel: mockUpdateChatModel,
    },
    modelService: {
      fetchAvailableModels: mockFetchAvailableModels,
    },
    openService: {
      openChat: vi.fn(),
    },
  }),
}));

import { useChatMutationActions } from './useChatMutationActions';

describe('useChatMutationActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGeneratingTitle.mockReturnValue(false);
    mockGenerateChatTitle.mockResolvedValue('Generated');
    mockFetchAvailableModels.mockResolvedValue(['model-a']);
  });

  it('exposes shared action state', () => {
    const chatMutationActions = useChatMutationActions();

    expect(chatMutationActions.availableModels.value).toEqual(['model-a']);
    expect(chatMutationActions.fetchingModels.value).toBe(false);
    expect(chatMutationActions.isGeneratingTitle({ chatId: 'chat-1' })).toBe(false);
  });

  it('delegates scoped mutations to the compat store', async () => {
    const chatMutationActions = useChatMutationActions();

    await chatMutationActions.moveChatToGroup({
      chatId: 'chat-1',
      targetGroupId: 'group-1',
    });
    await chatMutationActions.toggleDebugForChat({
      chatId: 'chat-1',
    });
    await chatMutationActions.renameChat({
      id: 'chat-1',
      newTitle: 'Renamed',
    });
    await chatMutationActions.generateChatTitle({
      chatId: 'chat-1',
      titleModelIdOverride: 'model-a',
    });
    chatMutationActions.abortTitleGeneration({
      chatId: 'chat-1',
    });
    await chatMutationActions.updateChatSettings({
      id: 'chat-1',
      updates: { titleModelId: 'model-a' },
    });
    await chatMutationActions.updateChatModel({
      id: 'chat-1',
      modelId: 'model-b',
    });
    await chatMutationActions.fetchAvailableModels({
      chatId: 'chat-1',
    });
    await chatMutationActions.commitFullHistoryManipulation({
      chatId: 'chat-1',
      messages: [],
      systemPrompt: undefined,
    });

    expect(mockMoveChatToGroup).toHaveBeenCalledWith({
      chatId: 'chat-1',
      targetGroupId: 'group-1',
    });
    expect(mockToggleDebugForChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
    expect(mockRenameChat).toHaveBeenCalledWith({
      id: 'chat-1',
      newTitle: 'Renamed',
    });
    expect(mockGenerateChatTitle).toHaveBeenCalledWith({
      chatId: 'chat-1',
      signal: undefined,
      titleModelIdOverride: 'model-a',
    });
    expect(mockAbortTitleGeneration).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
    expect(mockUpdateChatSettings).toHaveBeenCalledWith({
      id: 'chat-1',
      updates: { titleModelId: 'model-a' },
    });
    expect(mockUpdateChatModel).toHaveBeenCalledWith({
      id: 'chat-1',
      modelId: 'model-b',
    });
    expect(mockFetchAvailableModels).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
    expect(mockCommitFullHistoryManipulation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messages: [],
      systemPrompt: undefined,
    });
  });

  it('passes undefined modelId through to metadata service', async () => {
    const chatMutationActions = useChatMutationActions();

    await chatMutationActions.updateChatModel({
      id: 'chat-1',
      modelId: undefined,
    });

    expect(mockUpdateChatModel).toHaveBeenCalledWith({
      id: 'chat-1',
      modelId: undefined,
    });
  });
});
