import { ensureChatTmpDirectory } from '@/composables/chat/global/chat-core-singletons';
import type { ChatTmpDirectoryEntry } from '@/composables/chat/global/chat-tmp-directory-store';
import type { ChatId } from '@/models/ids';

export type ChatTmpDirectoryAdapter = {
  ensureChatTmpDirectory({
    chatId,
  }: {
    chatId: ChatId;
  }): Promise<ChatTmpDirectoryEntry>;

  TEST_ONLY: Record<never, never>;
};

export function useChatTmpDirectory(): ChatTmpDirectoryAdapter {
  return {
    ensureChatTmpDirectory,
    TEST_ONLY: {},
  };
}
