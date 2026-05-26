import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCurrentChat,
  mockAddMount,
  mockRemoveMount,
  mockUpdateMount,
} = vi.hoisted(() => ({
  mockCurrentChat: { value: null as { id: string; mounts?: any[] } | null },
  mockAddMount: vi.fn(),
  mockRemoveMount: vi.fn(),
  mockUpdateMount: vi.fn(),
}));

vi.mock('@/composables/chat/chat-scoped/useChatReadModel', () => ({
  useChatReadModel: () => ({
    currentChat: mockCurrentChat,
  }),
}));

vi.mock('@/composables/chat/ui/useChatMountActions', () => ({
  useChatMountActions: () => ({
    addMount: mockAddMount,
    removeMount: mockRemoveMount,
    updateMount: mockUpdateMount,
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

    expect(mockAddMount).not.toHaveBeenCalled();
    expect(mockRemoveMount).not.toHaveBeenCalled();
    expect(mockUpdateMount).not.toHaveBeenCalled();
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

    expect(mockAddMount).toHaveBeenCalledWith({
      chatId: 'chat-1',
      mount: { type: 'volume', volumeId: 'vol-2', mountPath: '/home/user/data', readOnly: false },
    });
    expect(mockRemoveMount).toHaveBeenCalledWith({
      chatId: 'chat-1',
      volumeId: 'vol-1',
    });
    expect(mockUpdateMount).toHaveBeenCalledWith({
      chatId: 'chat-1',
      volumeId: 'vol-2',
      readOnly: true,
    });
  });
});
