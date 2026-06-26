import type { ChatId } from '@/models/ids';
import {
  abortContextCompactForChat,
  runCompactCurrentBranchForChat,
} from '@/composables/chat/chat-scoped/chat-compact-flow';

export type ChatCompactionAdapter = {
  compactCurrentBranch({
    chatId,
    keepRecentMessages,
    instructionOverride,
  }: {
    chatId: ChatId,
    keepRecentMessages: number,
    instructionOverride: string | undefined,
  }): Promise<boolean>,

  abort({
    chatId,
  }: {
    chatId: ChatId,
  }): void,

  TEST_ONLY: Record<never, never>,
};

export function useChatCompaction(): ChatCompactionAdapter {
  async function compactCurrentBranch({
    chatId,
    keepRecentMessages,
    instructionOverride,
  }: {
    chatId: ChatId,
    keepRecentMessages: number,
    instructionOverride: string | undefined,
  }): Promise<boolean> {
    const result = await runCompactCurrentBranchForChat({
      chatId,
      keepRecentMessages,
      instructionOverride,
    });
    return result.status === 'compacted';
  }

  function abort({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    abortContextCompactForChat({
      chatId,
    });
  }

  return {
    compactCurrentBranch,
    abort,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
