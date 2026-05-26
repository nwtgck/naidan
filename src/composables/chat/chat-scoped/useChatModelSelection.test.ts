import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAvailableModels,
  mockFetchingModels,
  mockFetchAvailableModels,
  mockUpdateChatModel,
} = vi.hoisted(() => ({
  mockAvailableModels: { value: ['gpt-4'] as string[] },
  mockFetchingModels: { value: false },
  mockFetchAvailableModels: vi.fn(),
  mockUpdateChatModel: vi.fn(),
}));

vi.mock('@/composables/chat/ui/useChatMutationActions', () => ({
  useChatMutationActions: () => ({
    availableModels: mockAvailableModels,
    fetchingModels: mockFetchingModels,
    fetchAvailableModels: mockFetchAvailableModels,
    updateChatModel: mockUpdateChatModel,
  }),
}));

import { useChatModelSelection } from './useChatModelSelection';

describe('useChatModelSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAvailableModels.value = ['gpt-4'];
    mockFetchingModels.value = false;
    mockFetchAvailableModels.mockResolvedValue(['gpt-4', 'gpt-4o']);
  });

  it('binds fetch and update to the scoped chatId', async () => {
    const chatModelSelection = useChatModelSelection({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatModelSelection.availableModels.value).toEqual(['gpt-4']);
    expect(chatModelSelection.fetchingModels.value).toBe(false);
    await expect(chatModelSelection.fetchModels({})).resolves.toEqual(['gpt-4', 'gpt-4o']);

    await chatModelSelection.updateModel({ modelId: 'gpt-4o' });

    expect(mockFetchAvailableModels).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(mockUpdateChatModel).toHaveBeenCalledWith({
      id: 'chat-1',
      modelId: 'gpt-4o',
    });
  });

  it('no-ops update when chatId is undefined and still uses shared fetch fallback', async () => {
    const chatModelSelection = useChatModelSelection({
      chatId: computed(() => undefined),
    });

    await chatModelSelection.fetchModels({});
    await chatModelSelection.updateModel({ modelId: 'gpt-4o' });

    expect(mockFetchAvailableModels).toHaveBeenCalledWith({ chatId: undefined });
    expect(mockUpdateChatModel).not.toHaveBeenCalled();
  });
});
