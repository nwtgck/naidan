import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLoadData,
  mockOpenChat,
} = vi.hoisted(() => ({
  mockLoadData: vi.fn().mockResolvedValue(undefined),
  mockOpenChat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  loadData: mockLoadData,
}));

vi.mock('@/composables/chat/ui/useChatNavigation', () => ({
  useChatNavigation: () => ({
    openChat: mockOpenChat,
  }),
}));

import { useChatBootstrap } from './useChatBootstrap';

describe('useChatBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates load and open actions', async () => {
    const chatBootstrap = useChatBootstrap();

    await chatBootstrap.loadChats({});
    await chatBootstrap.openChat({
      chatId: 'chat-1',
    });

    expect(mockLoadData).toHaveBeenCalledWith({});
    expect(mockOpenChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
  });
});
