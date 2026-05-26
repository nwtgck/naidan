import { computed, type ComputedRef, type Ref } from 'vue';
import type { ChatGroup, Mount, SidebarItem } from '@/models/types';
import { storageService } from '@/services/storage';
import { currentChatGroupRef, rootItems } from '@/composables/chat/global/chat-core-singletons';

export type ChatGroupMountsAdapter = {
  mounts: ComputedRef<Mount[]>;

  addMount({
    mount,
  }: {
    mount: Mount;
  }): Promise<void>;

  removeMount({
    volumeId,
  }: {
    volumeId: string;
  }): Promise<void>;

  updateMount({
    volumeId,
    mountPath,
    readOnly,
  }: {
    volumeId: string;
    mountPath: string;
    readOnly: boolean;
  }): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useChatGroupMounts({
  chatGroupId,
}: {
  chatGroupId: Ref<string | undefined>;
}): ChatGroupMountsAdapter {
  const currentChatGroup = computed(() => {
    const id = chatGroupId.value;
    if (id === undefined) {
      return null;
    }

    return findChatGroupById({
      items: rootItems.value,
      chatGroupId: id,
    });
  });

  const mounts = computed(() => currentChatGroup.value?.mounts ?? []);

  async function addMount({
    mount,
  }: {
    mount: Mount;
  }): Promise<void> {
    const groupId = chatGroupId.value;
    if (groupId === undefined) {
      return;
    }

    await storageService.addMountToChatGroup({
      groupId,
      mount,
    });

    const group = currentChatGroup.value;
    if (group !== null) {
      group.mounts = [...(group.mounts ?? []), mount];
    }

    if (currentChatGroupRef.value?.id === groupId && currentChatGroupRef.value !== group) {
      currentChatGroupRef.value.mounts = [...(currentChatGroupRef.value.mounts ?? []), mount];
    }
  }

  async function removeMount({
    volumeId,
  }: {
    volumeId: string;
  }): Promise<void> {
    const groupId = chatGroupId.value;
    if (groupId === undefined) {
      return;
    }

    await storageService.removeMountFromChatGroup({
      groupId,
      volumeId,
    });

    const group = currentChatGroup.value;
    if (group !== null) {
      group.mounts = (group.mounts ?? []).filter(mount => !(mount.type === 'volume' && mount.volumeId === volumeId));
    }

    if (currentChatGroupRef.value?.id === groupId && currentChatGroupRef.value !== group) {
      currentChatGroupRef.value.mounts = (currentChatGroupRef.value.mounts ?? []).filter(
        mount => !(mount.type === 'volume' && mount.volumeId === volumeId)
      );
    }
  }

  async function updateMount({
    volumeId,
    mountPath,
    readOnly,
  }: {
    volumeId: string;
    mountPath: string;
    readOnly: boolean;
  }): Promise<void> {
    const groupId = chatGroupId.value;
    if (groupId === undefined) {
      return;
    }

    await storageService.updateChatGroupMount({
      groupId,
      volumeId,
      mountPath,
      readOnly,
    });

    const applyUpdate = ({
      mounts: existingMounts,
    }: {
      mounts: Mount[] | undefined;
    }): Mount[] => {
      return (existingMounts ?? []).map(mount =>
        mount.type === 'volume' && mount.volumeId === volumeId
          ? { ...mount, mountPath, readOnly }
          : mount
      );
    };

    const group = currentChatGroup.value;
    if (group !== null) {
      group.mounts = applyUpdate({ mounts: group.mounts });
    }

    if (currentChatGroupRef.value?.id === groupId && currentChatGroupRef.value !== group) {
      currentChatGroupRef.value.mounts = applyUpdate({
        mounts: currentChatGroupRef.value.mounts,
      });
    }
  }

  return {
    mounts,
    addMount,
    removeMount,
    updateMount,
    TEST_ONLY: {},
  };
}

function findChatGroupById({
  items,
  chatGroupId,
}: {
  items: SidebarItem[];
  chatGroupId: string;
}): ChatGroup | null {
  for (const item of items) {
    switch (item.type) {
    case 'chat':
      break;
    case 'chat_group':
      if (item.chatGroup.id === chatGroupId) {
        return item.chatGroup;
      }
      break;
    default: {
      const _ex: never = item;
      return _ex;
    }
    }
  }

  return null;
}
