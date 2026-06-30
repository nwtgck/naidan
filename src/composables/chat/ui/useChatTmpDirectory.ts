import { ensureChatTmpDirectory } from '@/composables/chat/global/chat-core-singletons';
import type { ChatTmpDirectoryEntry } from '@/composables/chat/global/chat-tmp-directory-store';
import type { ChatId } from '@/01-models/ids';

export type ChatTmpDirectoryAdapter = {
  ensureChatTmpDirectory({
    chatId,
  }: {
    chatId: ChatId,
  }): Promise<ChatTmpDirectoryEntry>,

  TEST_ONLY: Record<never, never>,
};

export function useChatTmpDirectory(): ChatTmpDirectoryAdapter {
  return {
    ensureChatTmpDirectory,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {},
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
