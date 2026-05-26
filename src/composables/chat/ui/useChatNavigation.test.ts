import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockOpenChat,
  mockOpenChatAtMessage,
  mockOpenChatGroup,
} = vi.hoisted(() => ({
  mockOpenChat: vi.fn(),
  mockOpenChatAtMessage: vi.fn(),
  mockOpenChatGroup: vi.fn(),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    openChat: mockOpenChat,
    openChatAtMessage: mockOpenChatAtMessage,
    openChatGroup: mockOpenChatGroup,
  }),
}));

import { useChatNavigation } from './useChatNavigation';

describe('useChatNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps openChat to the compat store signature', async () => {
    const chatNavigation = useChatNavigation();

    await chatNavigation.openChat({
      chatId: 'chat-1',
    });

    expect(mockOpenChat).toHaveBeenCalledWith({
      id: 'chat-1',
    });
  });

  it('maps openChatAtMessage to the compat store signature', async () => {
    const chatNavigation = useChatNavigation();

    await chatNavigation.openChatAtMessage({
      chatId: 'chat-1',
      messageId: 'message-1',
    });

    expect(mockOpenChatAtMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'message-1',
    });
  });

  it('maps openChatGroup to the compat store signature', () => {
    const chatNavigation = useChatNavigation();

    chatNavigation.openChatGroup({
      groupId: 'group-1',
    });

    expect(mockOpenChatGroup).toHaveBeenCalledWith({
      id: 'group-1',
    });
  });
});
