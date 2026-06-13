import { computed, type ComputedRef, type Ref } from 'vue';
import type { Mount } from '@/models/types';
import { storageService } from '@/services/storage';
import {
  currentChatRef,
  ensureChatTmpDirectory,
  getLiveChatById,
  getReadonlyChat,
  triggerCurrentChat,
} from '@/composables/chat/global/chat-core-singletons';

export type ChatMountsAdapter = {
  getMounts({
    chatId,
  }: {
    chatId: Readonly<Ref<string>>;
  }): ComputedRef<Mount[]>;

  addMount({
    chatId,
    mount,
  }: {
    chatId: string;
    mount: Mount;
  }): Promise<void>;

  removeMount({
    chatId,
    volumeId,
  }: {
    chatId: string;
    volumeId: string;
  }): Promise<void>;

  updateMount({
    chatId,
    volumeId,
    readOnly,
  }: {
    chatId: string;
    volumeId: string;
    readOnly: boolean;
  }): Promise<void>;

  TEST_ONLY: Record<never, never>;
};

export function useChatMounts(): ChatMountsAdapter {
  function getMounts({
    chatId,
  }: {
    chatId: Readonly<Ref<string>>;
  }): ComputedRef<Mount[]> {
    return computed(() => getReadonlyChat({ chatId: chatId.value })?.mounts ?? []);
  }

  async function addMount({
    chatId,
    mount,
  }: {
    chatId: string;
    mount: Mount;
  }): Promise<void> {
    await storageService.addMountToChat({
      chatId,
      mount,
    });
    await ensureChatTmpDirectory({ chatId });

    const chat = getLiveChatById({ chatId });
    if (chat !== undefined && chat !== null) {
      chat.mounts = [...(chat.mounts ?? []), mount];
      if (currentChatRef.value?.id === chatId) {
        triggerCurrentChat({ chatId });
      }
    }
  }

  async function removeMount({
    chatId,
    volumeId,
  }: {
    chatId: string;
    volumeId: string;
  }): Promise<void> {
    await storageService.removeMountFromChat({
      chatId,
      volumeId,
    });

    const chat = getLiveChatById({ chatId });
    if (chat !== undefined && chat !== null) {
      chat.mounts = (chat.mounts ?? []).filter(mount => !(mount.type === 'volume' && mount.volumeId === volumeId));
      if (currentChatRef.value?.id === chatId) {
        triggerCurrentChat({ chatId });
      }
    }
  }

  async function updateMount({
    chatId,
    volumeId,
    readOnly,
  }: {
    chatId: string;
    volumeId: string;
    readOnly: boolean;
  }): Promise<void> {
    await storageService.updateChatMount({
      chatId,
      volumeId,
      readOnly,
    });

    const chat = getLiveChatById({ chatId });
    if (chat !== undefined && chat !== null) {
      chat.mounts = (chat.mounts ?? []).map(mount =>
        mount.type === 'volume' && mount.volumeId === volumeId ? { ...mount, readOnly } : mount
      );
      if (currentChatRef.value?.id === chatId) {
        triggerCurrentChat({ chatId });
      }
    }
  }

  return {
    getMounts,
    addMount,
    removeMount,
    updateMount,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
