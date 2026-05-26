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
  mockFetchAvailableModels: vi.fn().mockResolvedValue(['model-a']),
  mockCommitFullHistoryManipulation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    availableModels: mockAvailableModels,
    fetchingModels: mockFetchingModels,
    moveChatToGroup: mockMoveChatToGroup,
    toggleDebug: mockToggleDebug,
    toggleDebugForChat: mockToggleDebugForChat,
    renameChat: mockRenameChat,
    generateChatTitle: mockGenerateChatTitle,
    abortTitleGeneration: mockAbortTitleGeneration,
    isGeneratingTitle: mockIsGeneratingTitle,
    updateChatSettings: mockUpdateChatSettings,
    fetchAvailableModels: mockFetchAvailableModels,
    commitFullHistoryManipulation: mockCommitFullHistoryManipulation,
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
    expect(mockFetchAvailableModels).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
    expect(mockCommitFullHistoryManipulation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messages: [],
      systemPrompt: undefined,
    });
  });
});
