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
    readOnly,
  }: {
    volumeId: string;
    readOnly: boolean;
  }): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useChatMounts({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatMountsAdapter {
  const mounts = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return [];
    }

    return getReadonlyChat({ chatId: id })?.mounts ?? [];
  });

  async function addMount({
    mount,
  }: {
    mount: Mount;
  }) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    await storageService.addMountToChat({
      chatId: id,
      mount,
    });
    await ensureChatTmpDirectory({ chatId: id });

    const chat = getLiveChatById({ chatId: id });
    if (chat !== undefined && chat !== null) {
      chat.mounts = [...(chat.mounts ?? []), mount];
      if (currentChatRef.value?.id === id) {
        triggerCurrentChat({ chatId: id });
      }
    }
  }

  async function removeMount({
    volumeId,
  }: {
    volumeId: string;
  }) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    await storageService.removeMountFromChat({
      chatId: id,
      volumeId,
    });

    const chat = getLiveChatById({ chatId: id });
    if (chat !== undefined && chat !== null) {
      chat.mounts = (chat.mounts ?? []).filter(mount => !(mount.type === 'volume' && mount.volumeId === volumeId));
      if (currentChatRef.value?.id === id) {
        triggerCurrentChat({ chatId: id });
      }
    }
  }

  async function updateMount({
    volumeId,
    readOnly,
  }: {
    volumeId: string;
    readOnly: boolean;
  }) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    await storageService.updateChatMount({
      chatId: id,
      volumeId,
      readOnly,
    });

    const chat = getLiveChatById({ chatId: id });
    if (chat !== undefined && chat !== null) {
      chat.mounts = (chat.mounts ?? []).map(mount =>
        mount.type === 'volume' && mount.volumeId === volumeId ? { ...mount, readOnly } : mount
      );
      if (currentChatRef.value?.id === id) {
        triggerCurrentChat({ chatId: id });
      }
    }
  }

  return {
    mounts,
    addMount,
    removeMount,
    updateMount,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
