import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateChatGroup,
  mockDeleteAllChats,
} = vi.hoisted(() => ({
  mockCreateChatGroup: vi.fn(),
  mockDeleteAllChats: vi.fn(),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    createChatGroup: mockCreateChatGroup,
    deleteAllChats: mockDeleteAllChats,
  }),
}));

import { useChatAdminActions } from './useChatAdminActions';

describe('useChatAdminActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateChatGroup.mockResolvedValue('group-1');
    mockDeleteAllChats.mockResolvedValue(undefined);
  });

  it('maps createChatGroup to the compat store signature', async () => {
    const chatAdminActions = useChatAdminActions();

    await expect(chatAdminActions.createChatGroup({
      name: 'Group 1',
      options: {
        modelId: 'model-1',
      },
    })).resolves.toBe('group-1');

    expect(mockCreateChatGroup).toHaveBeenCalledWith({
      name: 'Group 1',
      options: {
        modelId: 'model-1',
      },
    });
  });

  it('maps deleteAllChats to the compat store signature', async () => {
    const chatAdminActions = useChatAdminActions();

    await chatAdminActions.deleteAllChats({});

    expect(mockDeleteAllChats).toHaveBeenCalledWith({});
  });
});
