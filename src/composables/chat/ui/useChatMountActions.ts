import type { Mount } from '@/models/types';
import { useChatUiServices } from './useChatUiServices';

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

export function useChatMountActions(): ChatMountActionsAdapter {
  const { mountService } = useChatUiServices({});

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

    await mountService.addMountToChat({
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

    await mountService.removeMountFromChat({
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

    await mountService.updateChatMount({
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
