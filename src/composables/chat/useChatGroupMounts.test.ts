import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCurrentChatGroupRef,
  mockRootItems,
  mockAddMountToChatGroup,
  mockRemoveMountFromChatGroup,
  mockUpdateChatGroupMount,
} = vi.hoisted(() => ({
  mockCurrentChatGroupRef: {
    value: null as { id: string; mounts?: any[] } | null,
  },
  mockRootItems: {
    value: [] as any[],
  },
  mockAddMountToChatGroup: vi.fn().mockResolvedValue(undefined),
  mockRemoveMountFromChatGroup: vi.fn().mockResolvedValue(undefined),
  mockUpdateChatGroupMount: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/storage', () => ({
  storageService: {
    addMountToChatGroup: mockAddMountToChatGroup,
    removeMountFromChatGroup: mockRemoveMountFromChatGroup,
    updateChatGroupMount: mockUpdateChatGroupMount,
  },
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  currentChatGroupRef: mockCurrentChatGroupRef,
  rootItems: mockRootItems,
}));

import { useChatGroupMounts } from './useChatGroupMounts';

describe('useChatGroupMounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentChatGroupRef.value = null;
    mockRootItems.value = [];
  });

  it('binds writes to the provided chatGroupId', async () => {
    mockCurrentChatGroupRef.value = {
      id: 'group-1',
      mounts: [{ type: 'volume', volumeId: 'vol-1', mountPath: '/mnt/vol-1', readOnly: true }],
    };
    mockRootItems.value = [
      {
        type: 'chat_group',
        chatGroup: {
          id: 'group-1',
          mounts: [{ type: 'volume', volumeId: 'vol-1', mountPath: '/mnt/vol-1', readOnly: true }],
        },
      },
    ];

    const chatGroupMounts = useChatGroupMounts({});

    await chatGroupMounts.addMount({
      chatGroupId: 'group-1',
      mount: { type: 'volume', volumeId: 'vol-2', mountPath: '/mnt/vol-2', readOnly: false },
    });
    await chatGroupMounts.removeMount({
      chatGroupId: 'group-1',
      volumeId: 'vol-1',
    });
    await chatGroupMounts.updateMount({
      chatGroupId: 'group-1',
      volumeId: 'vol-2',
      mountPath: '/mnt/shared',
      readOnly: true,
    });

    expect(mockAddMountToChatGroup).toHaveBeenCalledWith({
      groupId: 'group-1',
      mount: { type: 'volume', volumeId: 'vol-2', mountPath: '/mnt/vol-2', readOnly: false },
    });
    expect(mockRemoveMountFromChatGroup).toHaveBeenCalledWith({
      groupId: 'group-1',
      volumeId: 'vol-1',
    });
    expect(mockUpdateChatGroupMount).toHaveBeenCalledWith({
      groupId: 'group-1',
      volumeId: 'vol-2',
      mountPath: '/mnt/shared',
      readOnly: true,
    });
    expect(mockCurrentChatGroupRef.value?.mounts).toEqual([
      { type: 'volume', volumeId: 'vol-2', mountPath: '/mnt/shared', readOnly: true },
    ]);
  });
});
