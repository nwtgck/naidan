import type { Mount } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import {
  currentChatGroupRef,
  rootItems,
} from '@/composables/chat/global/chat-core-singletons';
import type { ChatGroupId, VolumeId } from '@/01-models/ids';

export type ChatGroupMountsAdapter = {
  addMount({
    chatGroupId,
    mount,
  }: {
    chatGroupId: ChatGroupId,
    mount: Mount,
  }): Promise<void>,

  removeMount({
    chatGroupId,
    volumeId,
  }: {
    chatGroupId: ChatGroupId,
    volumeId: VolumeId,
  }): Promise<void>,

  updateMount({
    chatGroupId,
    volumeId,
    mountPath,
    readOnly,
  }: {
    chatGroupId: ChatGroupId,
    volumeId: VolumeId,
    mountPath: string,
    readOnly: boolean,
  }): Promise<void>,

  TEST_ONLY: Record<never, never>,
};

export function useChatGroupMounts(): ChatGroupMountsAdapter {
  async function addMount({
    chatGroupId,
    mount,
  }: {
    chatGroupId: ChatGroupId,
    mount: Mount,
  }): Promise<void> {
    await storageService.addMountToChatGroup({
      groupId: chatGroupId,
      mount,
    });

    const group = findChatGroupById({
      chatGroupId,
    });
    if (group !== null) {
      group.mounts = [...(group.mounts ?? []), mount];
    }

    if (currentChatGroupRef.value?.id === chatGroupId && currentChatGroupRef.value !== group) {
      currentChatGroupRef.value.mounts = [...(currentChatGroupRef.value.mounts ?? []), mount];
    }
  }

  async function removeMount({
    chatGroupId,
    volumeId,
  }: {
    chatGroupId: ChatGroupId,
    volumeId: VolumeId,
  }): Promise<void> {
    await storageService.removeMountFromChatGroup({
      groupId: chatGroupId,
      volumeId,
    });

    const group = findChatGroupById({
      chatGroupId,
    });
    if (group !== null) {
      group.mounts = (group.mounts ?? []).filter(mount => !(mount.type === 'volume' && mount.volumeId === volumeId));
    }

    if (currentChatGroupRef.value?.id === chatGroupId && currentChatGroupRef.value !== group) {
      currentChatGroupRef.value.mounts = (currentChatGroupRef.value.mounts ?? []).filter(
        mount => !(mount.type === 'volume' && mount.volumeId === volumeId),
      );
    }
  }

  async function updateMount({
    chatGroupId,
    volumeId,
    mountPath,
    readOnly,
  }: {
    chatGroupId: ChatGroupId,
    volumeId: VolumeId,
    mountPath: string,
    readOnly: boolean,
  }): Promise<void> {
    await storageService.updateChatGroupMount({
      groupId: chatGroupId,
      volumeId,
      mountPath,
      readOnly,
    });

    const applyUpdate = ({
      mounts,
    }: {
      mounts: Mount[] | undefined,
    }): Mount[] => {
      return (mounts ?? []).map(mount =>
        mount.type === 'volume' && mount.volumeId === volumeId
          ? { ...mount, mountPath, readOnly }
          : mount,
      );
    };

    const group = findChatGroupById({
      chatGroupId,
    });
    if (group !== null) {
      group.mounts = applyUpdate({
        mounts: group.mounts,
      });
    }

    if (currentChatGroupRef.value?.id === chatGroupId && currentChatGroupRef.value !== group) {
      currentChatGroupRef.value.mounts = applyUpdate({
        mounts: currentChatGroupRef.value.mounts,
      });
    }
  }

  return {
    addMount,
    removeMount,
    updateMount,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}

function findChatGroupById({
  chatGroupId,
}: {
  chatGroupId: ChatGroupId,
}) {
  for (const item of rootItems.value) {
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
