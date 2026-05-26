import { computed, type ComputedRef, type Ref } from 'vue';
import type { Mount } from '@/models/types';
import { useChatReadModel } from '@/composables/chat/chat-scoped/useChatReadModel';
import { useChatMountActions } from '@/composables/chat/ui/useChatMountActions';

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
  const chatReadModel = useChatReadModel({ chatId });
  const chatMountActions = useChatMountActions();

  const mounts = computed(() => {
    return chatReadModel.currentChat.value?.mounts ?? [];
  });

  async function addMount({
    mount,
  }: {
    mount: Mount;
  }) {
    if (chatId.value === undefined) {
      return;
    }

    await chatMountActions.addMount({
      chatId: chatId.value,
      mount,
    });
  }

  async function removeMount({
    volumeId,
  }: {
    volumeId: string;
  }) {
    if (chatId.value === undefined) {
      return;
    }

    await chatMountActions.removeMount({
      chatId: chatId.value,
      volumeId,
    });
  }

  async function updateMount({
    volumeId,
    readOnly,
  }: {
    volumeId: string;
    readOnly: boolean;
  }) {
    if (chatId.value === undefined) {
      return;
    }

    await chatMountActions.updateMount({
      chatId: chatId.value,
      volumeId,
      readOnly,
    });
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
