import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toChatGroupId, toVolumeId } from '@/01-models/ids';
import type { ChatGroupId } from '@/01-models/ids';
import type { ChatGroup } from '@/01-models/types';
import { storageService } from '@/00-storage/service';

const {
  mockCurrentChatGroupRef,
  mockRootItems,
  mockAddMountToChatGroup,
  mockRemoveMountFromChatGroup,
  mockUpdateChatGroupMount,
  mockUpdateChatGroup,
} = vi.hoisted(() => {
  const mockCurrentChatGroupRef: { value: { id: ChatGroupId, mounts?: any[] } | null } = {
    value: null,
  };
  const mockRootItems: { value: any[] } = {
    value: [],
  };
  return {
    mockCurrentChatGroupRef,
    mockRootItems,
    mockAddMountToChatGroup: vi.fn().mockResolvedValue(undefined),
    mockRemoveMountFromChatGroup: vi.fn().mockResolvedValue(undefined),
    mockUpdateChatGroupMount: vi.fn().mockResolvedValue(undefined),
    mockUpdateChatGroup: vi.fn<typeof storageService.updateChatGroup>(),
  };
});

vi.mock('@/00-storage/service', () => ({
  storageService: {
    addMountToChatGroup: mockAddMountToChatGroup,
    removeMountFromChatGroup: mockRemoveMountFromChatGroup,
    updateChatGroupMount: mockUpdateChatGroupMount,
    updateChatGroup: mockUpdateChatGroup,
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
      id: toChatGroupId({ raw: 'group-1' }),
      mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'vol-1' }), mountPath: '/mnt/vol-1', readOnly: true }],
    };
    mockRootItems.value = [
      {
        type: 'chat_group',
        chatGroup: {
          id: toChatGroupId({ raw: 'group-1' }),
          mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'vol-1' }), mountPath: '/mnt/vol-1', readOnly: true }],
        },
      },
    ];

    const chatGroupMounts = useChatGroupMounts();

    await chatGroupMounts.addMount({
      chatGroupId: toChatGroupId({ raw: 'group-1' }),
      mount: { type: 'volume', volumeId: toVolumeId({ raw: 'vol-2' }), mountPath: '/mnt/vol-2', readOnly: false },
    });
    await chatGroupMounts.removeMount({
      chatGroupId: toChatGroupId({ raw: 'group-1' }),
      volumeId: toVolumeId({ raw: 'vol-1' }),
    });
    await chatGroupMounts.updateMount({
      chatGroupId: toChatGroupId({ raw: 'group-1' }),
      volumeId: toVolumeId({ raw: 'vol-2' }),
      mountPath: '/mnt/shared',
      readOnly: true,
    });

    expect(mockAddMountToChatGroup).toHaveBeenCalledWith({
      groupId: 'group-1',
      mount: { type: 'volume', volumeId: toVolumeId({ raw: 'vol-2' }), mountPath: '/mnt/vol-2', readOnly: false },
    });
    expect(mockRemoveMountFromChatGroup).toHaveBeenCalledWith({
      groupId: 'group-1',
      volumeId: toVolumeId({ raw: 'vol-1' }),
    });
    expect(mockUpdateChatGroupMount).toHaveBeenCalledWith({
      groupId: 'group-1',
      volumeId: toVolumeId({ raw: 'vol-2' }),
      mountPath: '/mnt/shared',
      readOnly: true,
    });
    expect(mockCurrentChatGroupRef.value?.mounts).toEqual([
      { type: 'volume', volumeId: toVolumeId({ raw: 'vol-2' }), mountPath: '/mnt/shared', readOnly: true },
    ]);
  });

  it('updates only permission on the latest saved and live entry', async () => {
    const chatGroupId = toChatGroupId({ raw: 'chat-group-permission' });
    const volumeId = toVolumeId({ raw: 'volume' });
    const current: ChatGroup = {
      id: chatGroupId,
      name: 'Latest name',
      isCollapsed: false,
      items: [],
      updatedAt: 100,
      mounts: [{ type: 'volume', volumeId, mountPath: '/latest-path', readOnly: true }],
    };
    mockRootItems.value = [{ type: 'chat_group', chatGroup: current }];
    mockCurrentChatGroupRef.value = current;
    mockUpdateChatGroup.mockImplementation(async ({ id, updater }) => {
      expect(id).toBe(chatGroupId);
      const result = await updater({ current });
      if (!result) {
        throw new Error('Expected mount update');
      }
      expect(result.name).toBe('Latest name');
      expect(result.mounts).toEqual([{ type: 'volume', volumeId, mountPath: '/latest-path', readOnly: false }]);
      // A path change while persistence is pending must also survive the live update.
      current.mounts = [{ type: 'volume', volumeId, mountPath: '/newer-live-path', readOnly: true }];
    });
    await useChatGroupMounts().setMountReadOnly({ chatGroupId, volumeId, readOnly: false });
    expect(current.mounts).toEqual([{ type: 'volume', volumeId, mountPath: '/newer-live-path', readOnly: false }]);
    expect(mockUpdateChatGroupMount).not.toHaveBeenCalled();
  });

  it('does not recreate a removed mount or transfer a permission write to the current chat group', async () => {
    const chatGroupId = toChatGroupId({ raw: 'original-chat-group' });
    const nextChatGroup: ChatGroup = { id: toChatGroupId({ raw: 'next-chat-group' }), name: 'Next', isCollapsed: false, items: [], updatedAt: 0 };
    const original: ChatGroup = { id: chatGroupId, name: 'Original', isCollapsed: false, items: [], updatedAt: 0, mounts: [] };
    mockCurrentChatGroupRef.value = nextChatGroup;
    mockRootItems.value = [{ type: 'chat_group', chatGroup: original }];
    mockUpdateChatGroup.mockImplementation(async ({ updater }) => {
      expect((await updater({ current: original }))?.mounts).toEqual([]);
    });
    await useChatGroupMounts().setMountReadOnly({ chatGroupId, volumeId: toVolumeId({ raw: 'removed-volume' }), readOnly: false });
    expect(original.mounts).toEqual([]);
    expect(nextChatGroup.mounts).toBeUndefined();
  });

  it('rejects a missing original owner instead of updating another chat group', async () => {
    mockUpdateChatGroup.mockImplementation(async ({ updater }) => {
      await updater({ current: null });
    });
    await expect(useChatGroupMounts().setMountReadOnly({ chatGroupId: toChatGroupId({ raw: 'missing-chat-group' }), volumeId: toVolumeId({ raw: 'volume' }), readOnly: false })).rejects.toThrow('Chat group not found');
  });
});
