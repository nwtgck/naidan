import { toChatId, toMessageId, toChatGroupId } from '@/01-models/ids';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, ChatGroup } from '@/01-models/types';
import { currentChatGroupRef, currentChatRef } from '@/composables/chat/global/chat-core-singletons';

const {
  mockSetCurrentChatId,
  mockSetToolEnabled,
  mockHasMountsForChat,
  mockStoreOpenChat,
  mockStoreOpenChatAtMessage,
  mockStoreOpenChatGroup,
  mockLoadChatGroup,
  mockStorageCurrent,
} = vi.hoisted(() => ({
  mockSetCurrentChatId: vi.fn(),
  mockSetToolEnabled: vi.fn(),
  mockHasMountsForChat: vi.fn(() => false),
  mockStoreOpenChat: vi.fn(),
  mockStoreOpenChatAtMessage: vi.fn(),
  mockStoreOpenChatGroup: vi.fn(),
  mockLoadChatGroup: vi.fn(),
  mockStorageCurrent: vi.fn(() => true),
}));

vi.mock('@/00-storage/service', () => ({ storageService: { loadChatGroup: mockLoadChatGroup, captureSettingsStorage: () => mockStorageCurrent } }));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: {
      value: {},
    },
  }),
}));

vi.mock('@/features/tools/composables/useChatTools', () => ({
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
  currentChatGroupRef: { value: null },
  rootItems: { value: [] },
}));

import { useChatNavigation } from './useChatNavigation';

describe('useChatNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreOpenChat.mockResolvedValue({ id: 'chat-1' });
    mockStoreOpenChatAtMessage.mockResolvedValue({ id: 'chat-1' });
    mockStorageCurrent.mockReturnValue(true);
    currentChatRef.value = null;
    currentChatGroupRef.value = null;
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

  const loadedChatGroup: ChatGroup = { id: toChatGroupId({ raw: 'persisted-chat-group' }), name: 'Persisted chat group', items: [], isCollapsed: false, updatedAt: 1 };
  const previousChat: Chat = { id: toChatId({ raw: 'previous-chat' }), title: 'Previous chat', root: { items: [] }, createdAt: 0, updatedAt: 1, debugEnabled: false };

  it('selects an authoritative loaded group even when it is absent from the cached sidebar', async () => {
    mockLoadChatGroup.mockResolvedValueOnce(loadedChatGroup);
    currentChatRef.value = previousChat;
    await expect(useChatNavigation().loadAndOpenChatGroup({ groupId: loadedChatGroup.id, isCurrent: () => true })).resolves.toBe(loadedChatGroup);
    expect(mockLoadChatGroup).toHaveBeenCalledWith({ id: loadedChatGroup.id });
    expect(currentChatRef.value).toBeNull();
    expect(currentChatGroupRef.value).toBe(loadedChatGroup);
    expect(mockStoreOpenChatGroup).not.toHaveBeenCalled();
  });

  it('preserves the current selection while a group read is pending or rejects', async () => {
    const pending = Promise.withResolvers<ChatGroup | null>();
    mockLoadChatGroup.mockReturnValueOnce(pending.promise);
    currentChatRef.value = previousChat;
    const result = useChatNavigation().loadAndOpenChatGroup({ groupId: loadedChatGroup.id, isCurrent: () => true });
    expect(currentChatRef.value).toBe(previousChat);
    expect(currentChatGroupRef.value).toBeNull();
    pending.reject(new Error('Unreadable group'));
    await expect(result).rejects.toThrow('Unreadable group');
    expect(currentChatRef.value).toBe(previousChat);
    expect(currentChatGroupRef.value).toBeNull();
  });

  it('returns an absent group without selecting a previous cached group', async () => {
    mockLoadChatGroup.mockResolvedValueOnce(null);
    currentChatGroupRef.value = loadedChatGroup;
    await expect(useChatNavigation().loadAndOpenChatGroup({ groupId: toChatGroupId({ raw: 'missing' }), isCurrent: () => true })).resolves.toBeNull();
    expect(currentChatGroupRef.value).toBe(loadedChatGroup);
  });

  for (const invalidation of ['navigation', 'storage'] as const) {
    it(`does not select a late group after ${invalidation} changes`, async () => {
      const pending = Promise.withResolvers<ChatGroup | null>();
      mockLoadChatGroup.mockReturnValueOnce(pending.promise);
      let current = true;
      const result = useChatNavigation().loadAndOpenChatGroup({ groupId: loadedChatGroup.id, isCurrent: () => current });
      switch (invalidation) {
      case 'navigation': current = false;
        break;
      case 'storage': mockStorageCurrent.mockReturnValue(false);
        break;
      default: {
        const exhaustive: never = invalidation;
        throw new Error(String(exhaustive));
      }
      }
      pending.resolve(loadedChatGroup);
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(currentChatRef.value).toBeNull();
      expect(currentChatGroupRef.value).toBeNull();
    });
  }

  for (const method of ['openChat', 'openChatAtMessage'] as const) {
    const storeOpen = method === 'openChat' ? mockStoreOpenChat : mockStoreOpenChatAtMessage;
    const args = { chatId: toChatId({ raw: 'broken-chat' }), leafId: undefined, messageId: toMessageId({ raw: 'message-1' }) };

    it(`${method} leaves tool selection unchanged while a read is pending or rejected`, async () => {
      let rejectRead!: (error: Error) => void;
      storeOpen.mockReturnValueOnce(new Promise((_resolve, reject) => {
        rejectRead = reject;
      }));
      const result = useChatNavigation()[method](args);

      expect(mockSetCurrentChatId).not.toHaveBeenCalled();
      rejectRead(new Error('Unreadable chat'));
      await expect(result).rejects.toThrow('Unreadable chat');
      expect(mockSetCurrentChatId).not.toHaveBeenCalled();
      expect(mockSetToolEnabled).not.toHaveBeenCalled();
    });

    it(`${method} clears tool selection for an absent chat`, async () => {
      storeOpen.mockResolvedValueOnce(null);
      await expect(useChatNavigation()[method](args)).resolves.toBeNull();
      expect(mockSetCurrentChatId).toHaveBeenCalledExactlyOnceWith({ chatId: null });
    });
  }
});
