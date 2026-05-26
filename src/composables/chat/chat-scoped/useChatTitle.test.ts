import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGeneratingTitle,
  mockIsGeneratingTitle,
  mockRenameChat,
  mockGenerateChatTitle,
  mockAbortTitleGeneration,
} = vi.hoisted(() => ({
  mockGeneratingTitle: { value: false },
  mockIsGeneratingTitle: vi.fn(),
  mockRenameChat: vi.fn(),
  mockGenerateChatTitle: vi.fn(),
  mockAbortTitleGeneration: vi.fn(),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    generatingTitle: mockGeneratingTitle,
    isGeneratingTitle: mockIsGeneratingTitle,
    renameChat: mockRenameChat,
    generateChatTitle: mockGenerateChatTitle,
    abortTitleGeneration: mockAbortTitleGeneration,
  }),
}));

import { useChatTitle } from './useChatTitle';

describe('useChatTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGeneratingTitle.value = false;
    mockIsGeneratingTitle.mockReturnValue(false);
    mockGenerateChatTitle.mockResolvedValue('Generated');
  });

  it('no-ops when chatId is undefined', async () => {
    const chatTitle = useChatTitle({
      chatId: computed(() => undefined),
    });

    expect(chatTitle.isGenerating.value).toBe(false);
    await expect(chatTitle.rename({ title: 'Next Title' })).resolves.toBeUndefined();
    await expect(chatTitle.generateTitle({ titleModelIdOverride: 'model-1' })).resolves.toBeUndefined();
    chatTitle.abort({});

    expect(mockRenameChat).not.toHaveBeenCalled();
    expect(mockGenerateChatTitle).not.toHaveBeenCalled();
    expect(mockAbortTitleGeneration).toHaveBeenCalledWith({ chatId: undefined });
  });

  it('binds title actions to the scoped chatId', async () => {
    mockIsGeneratingTitle.mockReturnValue(true);

    const chatTitle = useChatTitle({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatTitle.isGenerating.value).toBe(true);
    await expect(chatTitle.rename({ title: 'Next Title' })).resolves.toBeUndefined();
    await expect(chatTitle.generateTitle({ titleModelIdOverride: 'model-1' })).resolves.toBe('Generated');
    chatTitle.abort({});

    expect(mockRenameChat).toHaveBeenCalledWith({
      id: 'chat-1',
      newTitle: 'Next Title',
    });
    expect(mockGenerateChatTitle).toHaveBeenCalledWith({
      chatId: 'chat-1',
      signal: undefined,
      titleModelIdOverride: 'model-1',
    });
    expect(mockAbortTitleGeneration).toHaveBeenCalledWith({ chatId: 'chat-1' });
  });
});
