import { toRaw, triggerRef, type Ref } from 'vue';
import type { Chat, ChatGroup, Mount } from '@/models/types';

export type ChatMountService = {
  addMountToChat({
    chatId,
    mount,
  }: {
    chatId: string;
    mount: Mount;
  }): Promise<void>;

  removeMountFromChat({
    chatId,
    volumeId,
  }: {
    chatId: string;
    volumeId: string;
  }): Promise<void>;

  updateChatMount({
    chatId,
    volumeId,
    readOnly,
  }: {
    chatId: string;
    volumeId: string;
    readOnly: boolean;
  }): Promise<void>;

  addMountToChatGroup({
    groupId,
    mount,
  }: {
    groupId: string;
    mount: Mount;
  }): Promise<void>;

  removeMountFromChatGroup({
    groupId,
    volumeId,
  }: {
    groupId: string;
    volumeId: string;
  }): Promise<void>;

  updateChatGroupMount({
    groupId,
    volumeId,
    mountPath,
    readOnly,
  }: {
    groupId: string;
    volumeId: string;
    mountPath: string;
    readOnly: boolean;
  }): Promise<void>;
};

export function createChatMountService({
  currentChatRef,
  currentChatGroupRef,
  liveChatRegistry,
  ensureChatTmpDirectory,
  addMountToChatInStorage,
  removeMountFromChatInStorage,
  updateChatMountInStorage,
  addMountToChatGroupInStorage,
  removeMountFromChatGroupInStorage,
  updateChatGroupMountInStorage,
}: {
  currentChatRef: Ref<Chat | null>;
  currentChatGroupRef: Ref<ChatGroup | null>;
  liveChatRegistry: Map<string, Chat>;
  ensureChatTmpDirectory: ({ chatId }: { chatId: string }) => Promise<unknown>;
  addMountToChatInStorage: ({ chatId, mount }: { chatId: string; mount: Mount }) => Promise<void>;
  removeMountFromChatInStorage: ({ chatId, volumeId }: { chatId: string; volumeId: string }) => Promise<void>;
  updateChatMountInStorage: ({ chatId, volumeId, readOnly }: { chatId: string; volumeId: string; readOnly: boolean }) => Promise<void>;
  addMountToChatGroupInStorage: ({ groupId, mount }: { groupId: string; mount: Mount }) => Promise<void>;
  removeMountFromChatGroupInStorage: ({ groupId, volumeId }: { groupId: string; volumeId: string }) => Promise<void>;
  updateChatGroupMountInStorage: ({
    groupId,
    volumeId,
    mountPath,
    readOnly,
  }: {
    groupId: string;
    volumeId: string;
    mountPath: string;
    readOnly: boolean;
  }) => Promise<void>;
}): ChatMountService {
  async function addMountToChat({
    chatId,
    mount,
  }: {
    chatId: string;
    mount: Mount;
  }) {
    await addMountToChatInStorage({ chatId, mount });
    await ensureChatTmpDirectory({ chatId });
    const existing = liveChatRegistry.get(chatId);
    if (existing) {
      existing.mounts = [...(existing.mounts ?? []), mount];
      if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) {
        triggerRef(currentChatRef);
      }
    }
  }

  async function removeMountFromChat({
    chatId,
    volumeId,
  }: {
    chatId: string;
    volumeId: string;
  }) {
    await removeMountFromChatInStorage({ chatId, volumeId });
    const existing = liveChatRegistry.get(chatId);
    if (existing) {
      existing.mounts = (existing.mounts ?? []).filter(mount => !(mount.type === 'volume' && mount.volumeId === volumeId));
      if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) {
        triggerRef(currentChatRef);
      }
    }
  }

  async function updateChatMount({
    chatId,
    volumeId,
    readOnly,
  }: {
    chatId: string;
    volumeId: string;
    readOnly: boolean;
  }) {
    await updateChatMountInStorage({ chatId, volumeId, readOnly });
    const existing = liveChatRegistry.get(chatId);
    if (existing) {
      existing.mounts = (existing.mounts ?? []).map(mount =>
        mount.type === 'volume' && mount.volumeId === volumeId ? { ...mount, readOnly } : mount
      );
      if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) {
        triggerRef(currentChatRef);
      }
    }
  }

  async function addMountToChatGroup({
    groupId,
    mount,
  }: {
    groupId: string;
    mount: Mount;
  }) {
    await addMountToChatGroupInStorage({ groupId, mount });
    if (currentChatGroupRef.value?.id === groupId) {
      currentChatGroupRef.value.mounts = [...(currentChatGroupRef.value.mounts ?? []), mount];
    }
  }

  async function removeMountFromChatGroup({
    groupId,
    volumeId,
  }: {
    groupId: string;
    volumeId: string;
  }) {
    await removeMountFromChatGroupInStorage({ groupId, volumeId });
    if (currentChatGroupRef.value?.id === groupId) {
      currentChatGroupRef.value.mounts = (currentChatGroupRef.value.mounts ?? []).filter(
        mount => !(mount.type === 'volume' && mount.volumeId === volumeId)
      );
    }
  }

  async function updateChatGroupMount({
    groupId,
    volumeId,
    mountPath,
    readOnly,
  }: {
    groupId: string;
    volumeId: string;
    mountPath: string;
    readOnly: boolean;
  }) {
    await updateChatGroupMountInStorage({ groupId, volumeId, mountPath, readOnly });
    if (currentChatGroupRef.value?.id === groupId) {
      currentChatGroupRef.value.mounts = (currentChatGroupRef.value.mounts ?? []).map(mount =>
        mount.type === 'volume' && mount.volumeId === volumeId ? { ...mount, mountPath, readOnly } : mount
      );
    }
  }

  return {
    addMountToChat,
    removeMountFromChat,
    updateChatMount,
    addMountToChatGroup,
    removeMountFromChatGroup,
    updateChatGroupMount,
  };
}
