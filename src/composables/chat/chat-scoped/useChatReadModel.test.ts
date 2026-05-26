import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetReadonlyChat,
  mockRootItems,
  mockSettings,
} = vi.hoisted(() => ({
  mockGetReadonlyChat: vi.fn(),
  mockRootItems: { value: [] as any[] },
  mockSettings: { value: {
    endpointType: 'openai',
    endpointUrl: 'http://localhost',
    defaultModelId: 'global-model',
  } },
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: mockSettings,
  }),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  getReadonlyChat: ({ chatId }: { chatId: string }) => mockGetReadonlyChat(chatId),
  rootItems: mockRootItems,
}));

import { useChatReadModel } from './useChatReadModel';

describe('useChatReadModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRootItems.value = [];
    mockGetReadonlyChat.mockReturnValue(null);
  });

  it('returns null/empty state when chatId is undefined', () => {
    const chatReadModel = useChatReadModel({
      chatId: computed(() => undefined),
    });

    expect(chatReadModel.currentChat.value).toBeNull();
    expect(chatReadModel.currentChatGroup.value).toBeNull();
    expect(chatReadModel.activeMessages.value).toEqual([]);
    expect(chatReadModel.allMessages.value).toEqual([]);
    expect(chatReadModel.resolvedSettings.value).toBeNull();
    expect(chatReadModel.inheritedSettings.value).toBeNull();
  });

  it('derives current chat, group, and messages from chatId', () => {
    mockRootItems.value = [{
      id: 'chat-group:g1',
      type: 'chat_group',
      chatGroup: {
        id: 'g1',
        name: 'Group 1',
        mounts: [],
        items: [],
      },
    }];
    mockGetReadonlyChat.mockReturnValue({
      id: 'chat-1',
      title: 'Chat 1',
      groupId: 'g1',
      root: {
        items: [{
          id: 'm1',
          role: 'user',
          content: 'hello',
          replies: { items: [] },
          timestamp: 1,
        }],
      },
      currentLeafId: 'm1',
      createdAt: 1,
      updatedAt: 1,
      debugEnabled: false,
    });

    const chatReadModel = useChatReadModel({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatReadModel.currentChat.value?.id).toBe('chat-1');
    expect(mockGetReadonlyChat).toHaveBeenCalledWith('chat-1');
    expect(chatReadModel.currentChatGroup.value?.id).toBe('g1');
    expect(chatReadModel.activeMessages.value.map(({ id }) => id)).toEqual(['m1']);
    expect(chatReadModel.allMessages.value.map(({ id }) => id)).toEqual(['m1']);
    expect(chatReadModel.resolvedSettings.value?.modelId).toBe('global-model');
    expect(chatReadModel.inheritedSettings.value?.modelId).toBe('global-model');
  });
});
