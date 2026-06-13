import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
} = vi.hoisted(() => ({
  mockCurrentChat: { value: null as { id: string; mounts?: any[] } | null },
  mockCurrentChatRef: { value: null as { id: string } | null },
  mockAddMountToChat: vi.fn().mockResolvedValue(undefined),
  mockRemoveMountFromChat: vi.fn().mockResolvedValue(undefined),
  mockUpdateChatMount: vi.fn().mockResolvedValue(undefined),
  mockEnsureChatTmpDirectory: vi.fn().mockResolvedValue({ handle: {}, mountPath: '/tmp' }),
  mockGetReadonlyChat: vi.fn(),
  mockGetLiveChatById: vi.fn(),
  mockTriggerCurrentChat: vi.fn(),
}));

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
      id: 'chat-1',
      mounts: [{ type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/work', readOnly: true }],
    };
    mockCurrentChat.value = liveChat;
    mockCurrentChatRef.value = { id: 'chat-1' };
    mockGetReadonlyChat.mockReturnValue(liveChat);
    mockGetLiveChatById.mockReturnValue(liveChat);

    const chatMounts = useChatMounts();
    const mounts = chatMounts.getMounts({
      chatId: computed(() => 'chat-1'),
    });

    expect(mounts.value).toEqual([
      { type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/work', readOnly: true },
    ]);

    await chatMounts.addMount({
      chatId: 'chat-1',
      mount: { type: 'volume', volumeId: 'vol-2', mountPath: '/home/user/data', readOnly: false },
    });
    await chatMounts.removeMount({
      chatId: 'chat-1',
      volumeId: 'vol-1',
    });
    await chatMounts.updateMount({
      chatId: 'chat-1',
      volumeId: 'vol-2',
      readOnly: true,
    });

    expect(mockAddMountToChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      mount: { type: 'volume', volumeId: 'vol-2', mountPath: '/home/user/data', readOnly: false },
    });
    expect(mockEnsureChatTmpDirectory).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
    expect(mockRemoveMountFromChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      volumeId: 'vol-1',
    });
    expect(mockUpdateChatMount).toHaveBeenCalledWith({
      chatId: 'chat-1',
      volumeId: 'vol-2',
      readOnly: true,
    });
    expect(mockTriggerCurrentChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
  });
});
