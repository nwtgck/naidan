import { loadData } from '@/composables/chat/global/chat-core-singletons';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';

export type ChatBootstrapAdapter = {
  loadChats(_args: Record<never, never>): Promise<void>;

  openChat({
    chatId,
  }: {
    chatId: string;
  }): Promise<unknown>;

  TEST_ONLY: Record<string, never>;
};

export function useChatBootstrap(): ChatBootstrapAdapter {
  const chatNavigation = useChatNavigation();

  async function loadChats(_args: Record<never, never>) {
    await loadData({});
  }

  async function openChat({
    chatId,
  }: {
    chatId: string;
  }) {
    return await chatNavigation.openChat({
      chatId,
      leafId: undefined,
    });
  }

  return {
    loadChats,
    openChat,
    TEST_ONLY: {},
  };
}
