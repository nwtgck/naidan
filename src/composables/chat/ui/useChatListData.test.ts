import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockState } = vi.hoisted(() => ({
  mockState: {
    chats: [{ id: 'chat-1', title: 'Chat 1', updatedAt: 0 }],
  },
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: {
      value: {},
    },
  }),
}));

vi.mock('@/composables/chat/chat-derived-state', () => ({
  createChatDerivedState: () => ({
    chats: computed(() => mockState.chats),
  }),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  currentChatRef: { value: null },
  rootItems: { value: [] },
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    chats: computed(() => mockState.chats),
  }),
}));

import { useChatListData } from './useChatListData';

describe('useChatListData', () => {
  beforeEach(() => {
    mockState.chats = [{ id: 'chat-1', title: 'Chat 1', updatedAt: 0 }];
  });

  it('exposes chats from the compat store', () => {
    const chatListData = useChatListData();

    expect(chatListData.chats.value).toEqual([{ id: 'chat-1', title: 'Chat 1', updatedAt: 0 }]);
  });
});
