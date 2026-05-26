import type { Mount } from '@/models/types';
import { useChat } from '@/composables/useChat';

export type ChatMountActionsAdapter = {
  addMount({
    chatId,
    mount,
  }: {
    chatId: string | undefined;
    mount: Mount;
  }): Promise<void>;

  removeMount({
    chatId,
    volumeId,
  }: {
    chatId: string | undefined;
    volumeId: string;
  }): Promise<void>;

  updateMount({
    chatId,
    volumeId,
    readOnly,
  }: {
    chatId: string | undefined;
    volumeId: string;
    readOnly: boolean;
  }): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

type ChatMountStoreCompatibility = ReturnType<typeof useChat>;

export function useChatMountActions(): ChatMountActionsAdapter {
  const chatStore = useChat() as ChatMountStoreCompatibility;

  async function addMount({
    chatId,
    mount,
  }: {
    chatId: string | undefined;
    mount: Mount;
  }) {
    if (chatId === undefined) {
      return;
    }

    await chatStore.addMountToChat({
      chatId,
      mount,
    });
  }

  async function removeMount({
    chatId,
    volumeId,
  }: {
    chatId: string | undefined;
    volumeId: string;
  }) {
    if (chatId === undefined) {
      return;
    }

    await chatStore.removeMountFromChat({
      chatId,
      volumeId,
    });
  }

  async function updateMount({
    chatId,
    volumeId,
    readOnly,
  }: {
    chatId: string | undefined;
    volumeId: string;
    readOnly: boolean;
  }) {
    if (chatId === undefined) {
      return;
    }

    await chatStore.updateChatMount({
      chatId,
      volumeId,
      readOnly,
    });
  }

  return {
    addMount,
    removeMount,
    updateMount,
    TEST_ONLY: {},
  };
}
