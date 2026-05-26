import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockServiceOpenChat,
  mockServiceOpenChatAtMessage,
  mockServiceOpenChatGroup,
} = vi.hoisted(() => ({
  mockServiceOpenChat: vi.fn(),
  mockServiceOpenChatAtMessage: vi.fn(),
  mockServiceOpenChatGroup: vi.fn(),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: {
      value: {},
    },
  }),
}));

vi.mock('@/composables/useChatTools', () => ({
  useChatTools: () => ({
    setCurrentChatId: vi.fn(),
    setToolEnabled: vi.fn(),
  }),
}));

vi.mock('@/composables/chat/chat-derived-state', () => ({
  createChatDerivedState: () => ({
    hasMountsForChat: vi.fn(() => false),
  }),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  chatDataStore: {},
  currentChatRef: { value: null },
  rootItems: { value: [] },
}));

vi.mock('@/composables/chat/services/chat-open-service', () => ({
  createChatOpenService: () => ({
    openChat: mockServiceOpenChat,
    openChatAtMessage: mockServiceOpenChatAtMessage,
    openChatGroup: mockServiceOpenChatGroup,
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
      leafId: undefined,
    });

    expect(mockServiceOpenChat).toHaveBeenCalledWith({
      id: 'chat-1',
      leafId: undefined,
    });
  });

  it('maps openChatAtMessage to the compat store signature', async () => {
    const chatNavigation = useChatNavigation();

    await chatNavigation.openChatAtMessage({
      chatId: 'chat-1',
      messageId: 'message-1',
    });

    expect(mockServiceOpenChatAtMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'message-1',
    });
  });

  it('maps openChatGroup to the compat store signature', () => {
    const chatNavigation = useChatNavigation();

    chatNavigation.openChatGroup({
      groupId: 'group-1',
    });

    expect(mockServiceOpenChatGroup).toHaveBeenCalledWith({
      id: 'group-1',
    });
  });
});
