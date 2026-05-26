import { computed, type ComputedRef, type Ref } from 'vue';
import type { Mount } from '@/models/types';
import { useChat } from '@/composables/useChat';

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
};

type ChatMountStoreCompatibility = {
  currentChat?: Ref<{ id: string; mounts?: Mount[] } | null>;
  addMountToChat: ({
    chatId,
    mount,
  }: {
    chatId: string;
    mount: Mount;
  }) => Promise<void>;
  removeMountFromChat: ({
    chatId,
    volumeId,
  }: {
    chatId: string;
    volumeId: string;
  }) => Promise<void>;
  updateChatMount: ({
    chatId,
    volumeId,
    readOnly,
  }: {
    chatId: string;
    volumeId: string;
    readOnly: boolean;
  }) => Promise<void>;
};

export function useChatMounts({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatMountsAdapter {
  const chatStore = useChat() as ChatMountStoreCompatibility;

  const mounts = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return [];
    }

    if (chatStore.currentChat?.value?.id === id) {
      return chatStore.currentChat.value.mounts ?? [];
    }

    return [];
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

    await chatStore.addMountToChat({
      chatId: id,
      mount,
    });
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

    await chatStore.removeMountFromChat({
      chatId: id,
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
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    await chatStore.updateChatMount({
      chatId: id,
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
