import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockIsGeneratingTitle,
  mockRenameChatById,
  mockGenerateChatTitleForChat,
  mockAbortTitleGenerationForChat,
} = vi.hoisted(() => ({
  mockIsGeneratingTitle: vi.fn(),
  mockRenameChatById: vi.fn(),
  mockGenerateChatTitleForChat: vi.fn(),
  mockAbortTitleGenerationForChat: vi.fn(),
}));

vi.mock('./chat-title-helpers', () => ({
  isGeneratingChatTitle: mockIsGeneratingTitle,
  generateChatTitleForChat: mockGenerateChatTitleForChat,
  abortTitleGenerationForChat: mockAbortTitleGenerationForChat,
}));

vi.mock('./chat-metadata-helpers', () => ({
  renameChatById: mockRenameChatById,
}));

import { useChatTitle } from './useChatTitle';

describe('useChatTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsGeneratingTitle.mockReturnValue(false);
    mockGenerateChatTitleForChat.mockResolvedValue('Generated');
  });

  it('no-ops when chatId is undefined', async () => {
    const chatTitle = useChatTitle({
      chatId: computed(() => undefined),
    });

    expect(chatTitle.isGenerating.value).toBe(false);
    await expect(chatTitle.rename({ title: 'Next Title' })).resolves.toBeUndefined();
    await expect(chatTitle.generateTitle({ titleModelIdOverride: 'model-1' })).resolves.toBeUndefined();
    chatTitle.abort({});

    expect(mockRenameChatById).not.toHaveBeenCalled();
    expect(mockGenerateChatTitleForChat).not.toHaveBeenCalled();
    expect(mockAbortTitleGenerationForChat).toHaveBeenCalledWith({ chatId: undefined });
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

    expect(mockRenameChatById).toHaveBeenCalledWith({
      chatId: 'chat-1',
      title: 'Next Title',
    });
    expect(mockGenerateChatTitleForChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      titleModelIdOverride: 'model-1',
      signal: undefined,
    });
    expect(mockAbortTitleGenerationForChat).toHaveBeenCalledWith({ chatId: 'chat-1' });
  });
});
