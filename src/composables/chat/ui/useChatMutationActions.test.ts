import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAvailableModels,
  mockFetchingModels,
  mockMoveChatToGroup,
  mockToggleDebugForChat,
  mockRenameChatById,
  mockGenerateChatTitleForChat,
  mockAbortTitleGenerationForChat,
  mockIsGeneratingTitle,
  mockUpdateChatSettingsById,
  mockUpdateChatModelById,
  mockFetchAvailableModelsForChat,
  mockCommitFullHistoryManipulation,
  mockGetCurrentChatId,
} = vi.hoisted(() => ({
  mockAvailableModels: { value: ['model-a'] },
  mockFetchingModels: { value: false },
  mockMoveChatToGroup: vi.fn().mockResolvedValue(undefined),
  mockToggleDebugForChat: vi.fn().mockResolvedValue(undefined),
  mockRenameChatById: vi.fn().mockResolvedValue(undefined),
  mockGenerateChatTitleForChat: vi.fn().mockResolvedValue('Generated'),
  mockAbortTitleGenerationForChat: vi.fn(),
  mockIsGeneratingTitle: vi.fn().mockReturnValue(false),
  mockUpdateChatSettingsById: vi.fn().mockResolvedValue(undefined),
  mockUpdateChatModelById: vi.fn().mockResolvedValue(undefined),
  mockFetchAvailableModelsForChat: vi.fn().mockResolvedValue(['model-a']),
  mockCommitFullHistoryManipulation: vi.fn().mockResolvedValue(undefined),
  mockGetCurrentChatId: vi.fn(() => 'chat-1'),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  availableModels: mockAvailableModels,
  chatRuntimeStore: {},
  currentChatRef: { value: null },
  fetchingModels: mockFetchingModels,
  getLiveChat: vi.fn(({ chat }) => chat),
  isProcessing: vi.fn(() => false),
  liveChatRegistry: new Map(),
  loadData: vi.fn(),
  registerLiveInstance: vi.fn(),
  updateChatContent: vi.fn(),
  updateChatMeta: vi.fn(),
}));

vi.mock('@/composables/chat/chat-scoped/chat-title-helpers', () => ({
  generateChatTitleForChat: mockGenerateChatTitleForChat,
  abortTitleGenerationForChat: mockAbortTitleGenerationForChat,
  isGeneratingChatTitle: mockIsGeneratingTitle,
}));

vi.mock('@/composables/chat/chat-scoped/chat-metadata-helpers', () => ({
  toggleDebugForChatId: mockToggleDebugForChat,
  renameChatById: mockRenameChatById,
  updateChatSettingsById: mockUpdateChatSettingsById,
  updateChatModelById: mockUpdateChatModelById,
}));

vi.mock('@/composables/chat/chat-scoped/chat-model-helpers', () => ({
  fetchAvailableModelsForChat: mockFetchAvailableModelsForChat,
}));

vi.mock('@/composables/chat/services/chat-history-service', () => ({
  createChatHistoryService: () => ({
    commitFullHistoryManipulation: mockCommitFullHistoryManipulation,
  }),
}));

vi.mock('./useChatUiServices', () => ({
  useChatUiServices: () => ({
    currentBridge: {
      getCurrentChatId: mockGetCurrentChatId,
      getChatTargetByOptionalId: vi.fn(),
      triggerCurrentChat: vi.fn(),
    },
  }),
}));

vi.mock('./useChatOrganization', () => ({
  useChatOrganization: () => ({
    moveChatToGroup: mockMoveChatToGroup,
  }),
}));

vi.mock('./useChatNavigation', () => ({
  useChatNavigation: () => ({
    openChat: vi.fn(),
  }),
}));

import { useChatMutationActions } from './useChatMutationActions';

describe('useChatMutationActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGeneratingTitle.mockReturnValue(false);
    mockGenerateChatTitleForChat.mockResolvedValue('Generated');
    mockFetchAvailableModelsForChat.mockResolvedValue(['model-a']);
    mockGetCurrentChatId.mockReturnValue('chat-1');
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
    await chatMutationActions.toggleDebug({});
    await chatMutationActions.toggleDebugForChat({ chatId: 'chat-1' });
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
    expect(mockToggleDebugForChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
    expect(mockRenameChatById).toHaveBeenCalledWith({
      chatId: 'chat-1',
      title: 'Renamed',
    });
    expect(mockGenerateChatTitleForChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      titleModelIdOverride: 'model-a',
      signal: undefined,
    });
    expect(mockAbortTitleGenerationForChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
    expect(mockUpdateChatSettingsById).toHaveBeenCalledWith({
      chatId: 'chat-1',
      updates: { titleModelId: 'model-a' },
    });
    expect(mockUpdateChatModelById).toHaveBeenCalledWith({
      chatId: 'chat-1',
      modelId: 'model-b',
    });
    expect(mockFetchAvailableModelsForChat).toHaveBeenCalledWith({
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

    expect(mockUpdateChatModelById).toHaveBeenCalledWith({
      chatId: 'chat-1',
      modelId: undefined,
    });
  });
});
