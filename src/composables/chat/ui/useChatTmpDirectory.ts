import { useChat } from '@/composables/useChat';
import type { ChatTmpDirectoryEntry } from '@/composables/chat/chat-tmp-directory-service';

export type ChatTmpDirectoryAdapter = {
  ensureChatTmpDirectory({
    chatId,
  }: {
    chatId: string;
  }): Promise<ChatTmpDirectoryEntry>;

  TEST_ONLY: Record<string, never>;
};

export function useChatTmpDirectory(): ChatTmpDirectoryAdapter {
  const chatStore = useChat();

  return {
    ensureChatTmpDirectory: chatStore.ensureChatTmpDirectory,
    TEST_ONLY: {},
  };
}
