import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCurrentChat,
  mockAddMountToChat,
  mockRemoveMountFromChat,
  mockUpdateChatMount,
} = vi.hoisted(() => ({
  mockCurrentChat: { value: null as { id: string; mounts?: any[] } | null },
  mockAddMountToChat: vi.fn(),
  mockRemoveMountFromChat: vi.fn(),
  mockUpdateChatMount: vi.fn(),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    addMountToChat: mockAddMountToChat,
    removeMountFromChat: mockRemoveMountFromChat,
    updateChatMount: mockUpdateChatMount,
  }),
}));

import { useChatMounts } from './useChatMounts';

describe('useChatMounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentChat.value = null;
  });

  it('returns empty mounts and no-ops when chatId is undefined', async () => {
    const chatMounts = useChatMounts({
      chatId: computed(() => undefined),
    });

    expect(chatMounts.mounts.value).toEqual([]);

    await chatMounts.addMount({
      mount: { type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/work', readOnly: true },
    });
    await chatMounts.removeMount({ volumeId: 'vol-1' });
    await chatMounts.updateMount({ volumeId: 'vol-1', readOnly: false });

    expect(mockAddMountToChat).not.toHaveBeenCalled();
    expect(mockRemoveMountFromChat).not.toHaveBeenCalled();
    expect(mockUpdateChatMount).not.toHaveBeenCalled();
  });

  it('binds reads and writes to the scoped chatId', async () => {
    mockCurrentChat.value = {
      id: 'chat-1',
      mounts: [{ type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/work', readOnly: true }],
    };

    const chatMounts = useChatMounts({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatMounts.mounts.value).toEqual([
      { type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/work', readOnly: true },
    ]);

    await chatMounts.addMount({
      mount: { type: 'volume', volumeId: 'vol-2', mountPath: '/home/user/data', readOnly: false },
    });
    await chatMounts.removeMount({ volumeId: 'vol-1' });
    await chatMounts.updateMount({ volumeId: 'vol-2', readOnly: true });

    expect(mockAddMountToChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      mount: { type: 'volume', volumeId: 'vol-2', mountPath: '/home/user/data', readOnly: false },
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
  });
});
