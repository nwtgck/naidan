import { ensureChatTmpDirectory } from '@/composables/chat/global/chat-core-singletons';
import type { ChatTmpDirectoryEntry } from '@/composables/chat/global/chat-tmp-directory-service';

export type ChatTmpDirectoryAdapter = {
  ensureChatTmpDirectory({
    chatId,
  }: {
    chatId: string;
  }): Promise<ChatTmpDirectoryEntry>;

  TEST_ONLY: Record<string, never>;
};

export function useChatTmpDirectory(): ChatTmpDirectoryAdapter {
  return {
    ensureChatTmpDirectory,
    TEST_ONLY: {},
  };
}
