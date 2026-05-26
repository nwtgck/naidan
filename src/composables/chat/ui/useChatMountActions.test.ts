import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAddMountToChat,
  mockRemoveMountFromChat,
  mockUpdateChatMount,
} = vi.hoisted(() => ({
  mockAddMountToChat: vi.fn(),
  mockRemoveMountFromChat: vi.fn(),
  mockUpdateChatMount: vi.fn(),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    addMountToChat: mockAddMountToChat,
    removeMountFromChat: mockRemoveMountFromChat,
    updateChatMount: mockUpdateChatMount,
  }),
}));

import { useChatMountActions } from './useChatMountActions';

describe('useChatMountActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops when chatId is undefined', async () => {
    const chatMountActions = useChatMountActions();

    await chatMountActions.addMount({
      chatId: undefined,
      mount: { type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/work', readOnly: true },
    });
    await chatMountActions.removeMount({
      chatId: undefined,
      volumeId: 'vol-1',
    });
    await chatMountActions.updateMount({
      chatId: undefined,
      volumeId: 'vol-1',
      readOnly: false,
    });

    expect(mockAddMountToChat).not.toHaveBeenCalled();
    expect(mockRemoveMountFromChat).not.toHaveBeenCalled();
    expect(mockUpdateChatMount).not.toHaveBeenCalled();
  });

  it('binds mutations to the provided chatId', async () => {
    const chatMountActions = useChatMountActions();

    await chatMountActions.addMount({
      chatId: 'chat-1',
      mount: { type: 'volume', volumeId: 'vol-2', mountPath: '/home/user/data', readOnly: false },
    });
    await chatMountActions.removeMount({
      chatId: 'chat-1',
      volumeId: 'vol-1',
    });
    await chatMountActions.updateMount({
      chatId: 'chat-1',
      volumeId: 'vol-2',
      readOnly: true,
    });

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
