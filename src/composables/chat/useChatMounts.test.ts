import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toChatId, toVolumeId } from '@/models/ids';
import type { ChatId } from '@/models/ids';

const {
  mockCurrentChat,
  mockCurrentChatRef,
  mockAddMountToChat,
  mockRemoveMountFromChat,
  mockUpdateChatMount,
  mockEnsureChatTmpDirectory,
  mockGetReadonlyChat,
  mockGetLiveChatById,
  mockTriggerCurrentChat,
} = vi.hoisted(() => {
  const mockCurrentChat: { value: { id: ChatId, mounts?: any[] } | null } = { value: null };
  const mockCurrentChatRef: { value: { id: ChatId } | null } = { value: null };
  return {
    mockCurrentChat,
    mockCurrentChatRef,
    mockAddMountToChat: vi.fn().mockResolvedValue(undefined),
    mockRemoveMountFromChat: vi.fn().mockResolvedValue(undefined),
    mockUpdateChatMount: vi.fn().mockResolvedValue(undefined),
    mockEnsureChatTmpDirectory: vi.fn().mockResolvedValue({ handle: {}, mountPath: '/tmp' }),
    mockGetReadonlyChat: vi.fn(),
    mockGetLiveChatById: vi.fn(),
    mockTriggerCurrentChat: vi.fn(),
  };
});

vi.mock('@/services/storage', () => ({
  storageService: {
    addMountToChat: mockAddMountToChat,
    removeMountFromChat: mockRemoveMountFromChat,
    updateChatMount: mockUpdateChatMount,
  },
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  currentChatRef: mockCurrentChatRef,
  ensureChatTmpDirectory: mockEnsureChatTmpDirectory,
  getReadonlyChat: mockGetReadonlyChat,
  getLiveChatById: mockGetLiveChatById,
  triggerCurrentChat: mockTriggerCurrentChat,
}));

import { useChatMounts } from './useChatMounts';

describe('useChatMounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentChat.value = null;
    mockCurrentChatRef.value = null;
    mockGetReadonlyChat.mockReturnValue(null);
    mockGetLiveChatById.mockReturnValue(undefined);
  });

  it('binds reads and writes to the provided chatId', async () => {
    const liveChat = {
      id: toChatId({ raw: 'chat-1' }),
      mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'vol-1' }), mountPath: '/home/user/work', readOnly: true }],
    };
    mockCurrentChat.value = liveChat;
    mockCurrentChatRef.value = { id: toChatId({ raw: 'chat-1' }) };
    mockGetReadonlyChat.mockReturnValue(liveChat);
    mockGetLiveChatById.mockReturnValue(liveChat);

    const chatMounts = useChatMounts();
    const mounts = chatMounts.getMounts({
      chatId: computed(() => toChatId({ raw: 'chat-1' })),
    });

    expect(mounts.value).toEqual([
      { type: 'volume', volumeId: toVolumeId({ raw: 'vol-1' }), mountPath: '/home/user/work', readOnly: true },
    ]);

    await chatMounts.addMount({
      chatId: toChatId({ raw: 'chat-1' }),
      mount: { type: 'volume', volumeId: toVolumeId({ raw: 'vol-2' }), mountPath: '/home/user/data', readOnly: false },
    });
    await chatMounts.removeMount({
      chatId: toChatId({ raw: 'chat-1' }),
      volumeId: toVolumeId({ raw: 'vol-1' }),
    });
    await chatMounts.updateMount({
      chatId: toChatId({ raw: 'chat-1' }),
      volumeId: toVolumeId({ raw: 'vol-2' }),
      readOnly: true,
    });

    expect(mockAddMountToChat).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
      mount: { type: 'volume', volumeId: toVolumeId({ raw: 'vol-2' }), mountPath: '/home/user/data', readOnly: false },
    });
    expect(mockEnsureChatTmpDirectory).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
    });
    expect(mockRemoveMountFromChat).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
      volumeId: toVolumeId({ raw: 'vol-1' }),
    });
    expect(mockUpdateChatMount).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
      volumeId: toVolumeId({ raw: 'vol-2' }),
      readOnly: true,
    });
    expect(mockTriggerCurrentChat).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
    });
  });
});
