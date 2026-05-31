import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAvailableModels,
  mockFetchingModels,
  mockFetchAvailableModelsForChat,
  mockUpdateChatModelById,
} = vi.hoisted(() => ({
  mockAvailableModels: { value: ['gpt-4'] as string[] },
  mockFetchingModels: { value: false },
  mockFetchAvailableModelsForChat: vi.fn(),
  mockUpdateChatModelById: vi.fn(),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  availableModels: mockAvailableModels,
  fetchingModels: mockFetchingModels,
}));

vi.mock('./chat-model-helpers', () => ({
  fetchAvailableModelsForChat: mockFetchAvailableModelsForChat,
}));

vi.mock('./chat-metadata-helpers', () => ({
  updateChatModelById: mockUpdateChatModelById,
}));

import { useChatModelSelection } from './useChatModelSelection';

describe('useChatModelSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAvailableModels.value = ['gpt-4'];
    mockFetchingModels.value = false;
    mockFetchAvailableModelsForChat.mockResolvedValue(['gpt-4', 'gpt-4o']);
  });

  it('binds fetch and update to the scoped chatId', async () => {
    const chatModelSelection = useChatModelSelection({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatModelSelection.availableModels.value).toEqual(['gpt-4']);
    expect(chatModelSelection.fetchingModels.value).toBe(false);
    await expect(chatModelSelection.fetchModels({})).resolves.toEqual(['gpt-4', 'gpt-4o']);

    await chatModelSelection.updateModel({ modelId: 'gpt-4o' });

    expect(mockFetchAvailableModelsForChat).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(mockUpdateChatModelById).toHaveBeenCalledWith({
      chatId: 'chat-1',
      modelId: 'gpt-4o',
    });
  });

  it('no-ops update when chatId is undefined and still uses shared fetch fallback', async () => {
    const chatModelSelection = useChatModelSelection({
      chatId: computed(() => undefined),
    });

    await chatModelSelection.fetchModels({});
    await chatModelSelection.updateModel({ modelId: 'gpt-4o' });

    expect(mockFetchAvailableModelsForChat).toHaveBeenCalledWith({ chatId: undefined });
    expect(mockUpdateChatModelById).not.toHaveBeenCalled();
  });
});
