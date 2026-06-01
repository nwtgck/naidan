import type { LmParameters } from '@/models/types';
import {
  editMessageForChat,
  forkChatForChat,
  switchVersionForChat,
} from '@/composables/chat/chat-scoped/chat-history-flow';

export type ChatBranchesAdapter = {
  editMessage({
    chatId,
    messageId,
    newContent,
    lmParameters,
  }: {
    chatId: string;
    messageId: string;
    newContent: string;
    lmParameters: LmParameters | undefined;
  }): Promise<void>;

  switchVersion({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }): Promise<void>;

  forkChat({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }): Promise<string | null>;

  TEST_ONLY: Record<string, never>;
};

export function useChatBranches(_args: Record<string, never>): ChatBranchesAdapter {
  async function editMessage({
    chatId,
    messageId,
    newContent,
    lmParameters,
  }: {
    chatId: string;
    messageId: string;
    newContent: string;
    lmParameters: LmParameters | undefined;
  }): Promise<void> {
    await editMessageForChat({
      chatId,
      messageId,
      newContent,
      lmParameters,
    });
  }

  async function switchVersion({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }): Promise<void> {
    await switchVersionForChat({
      chatId,
      messageId,
    });
  }

  async function forkChat({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }): Promise<string | null> {
    return await forkChatForChat({
      chatId,
      messageId,
    });
  }

  return {
    editMessage,
    switchVersion,
    forkChat,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
