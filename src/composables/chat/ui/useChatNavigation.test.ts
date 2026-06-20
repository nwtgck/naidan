import { toChatId, toMessageId, toChatGroupId } from '@/models/ids';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSetCurrentChatId,
  mockSetToolEnabled,
  mockHasMountsForChat,
  mockStoreOpenChat,
  mockStoreOpenChatAtMessage,
  mockStoreOpenChatGroup,
} = vi.hoisted(() => ({
  mockSetCurrentChatId: vi.fn(),
  mockSetToolEnabled: vi.fn(),
  mockHasMountsForChat: vi.fn(() => false),
  mockStoreOpenChat: vi.fn(),
  mockStoreOpenChatAtMessage: vi.fn(),
  mockStoreOpenChatGroup: vi.fn(),
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
    setCurrentChatId: mockSetCurrentChatId,
    setToolEnabled: mockSetToolEnabled,
  }),
}));

vi.mock('@/composables/chat/chat-derived-state', () => ({
  createChatDerivedState: () => ({
    hasMountsForChat: mockHasMountsForChat,
  }),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  chatDataStore: {
    openChat: mockStoreOpenChat,
    openChatAtMessage: mockStoreOpenChatAtMessage,
    openChatGroup: mockStoreOpenChatGroup,
  },
  currentChatRef: { value: null },
  rootItems: { value: [] },
}));

import { useChatNavigation } from './useChatNavigation';

describe('useChatNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreOpenChat.mockResolvedValue({ id: 'chat-1' });
    mockStoreOpenChatAtMessage.mockResolvedValue({ id: 'chat-1' });
  });

  it('maps openChat to the compat store signature', async () => {
    const chatNavigation = useChatNavigation();

    await chatNavigation.openChat({
      chatId: toChatId({ raw: 'chat-1' }),
      leafId: undefined,
    });

    expect(mockSetCurrentChatId).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-1' }) });
    expect(mockStoreOpenChat).toHaveBeenCalledWith({
      id: 'chat-1',
      leafId: undefined,
    });
  });

  it('maps openChatAtMessage to the compat store signature', async () => {
    const chatNavigation = useChatNavigation();

    await chatNavigation.openChatAtMessage({
      chatId: toChatId({ raw: 'chat-1' }),
      messageId: toMessageId({ raw: 'message-1' }),
    });

    expect(mockSetCurrentChatId).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-1' }) });
    expect(mockStoreOpenChatAtMessage).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
      messageId: toMessageId({ raw: 'message-1' }),
    });
  });

  it('maps openChatGroup to the compat store signature', () => {
    const chatNavigation = useChatNavigation();

    chatNavigation.openChatGroup({
      groupId: toChatGroupId({ raw: 'group-1' }),
    });

    expect(mockStoreOpenChatGroup).toHaveBeenCalledWith({
      id: 'group-1',
    });
  });
});
