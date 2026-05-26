import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockState } = vi.hoisted(() => ({
  mockState: {
    chats: [{ id: 'chat-1', title: 'Chat 1', updatedAt: 0 }],
  },
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
