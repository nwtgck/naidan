import type { ChatGroup } from '@/models/types';
import { useChat } from '@/composables/useChat';

export type ChatAdminActionsAdapter = {
  createChatGroup({
    name,
    options,
  }: {
    name: string;
    options?: Partial<Pick<ChatGroup, 'modelId' | 'systemPrompt' | 'lmParameters'>>;
  }): Promise<string>;

  deleteAllChats(_args: Record<never, never>): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useChatAdminActions(): ChatAdminActionsAdapter {
  const chatStore = useChat();

  async function createChatGroup({
    name,
    options,
  }: {
    name: string;
    options?: Partial<Pick<ChatGroup, 'modelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    return await chatStore.createChatGroup({
      name,
      options,
    });
  }

  async function deleteAllChats(_args: Record<never, never>) {
    await chatStore.deleteAllChats({});
  }

  return {
    createChatGroup,
    deleteAllChats,
    TEST_ONLY: {},
  };
}
