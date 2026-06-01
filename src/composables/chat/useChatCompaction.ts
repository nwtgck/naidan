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
    chatId: string;
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }): Promise<boolean>;

  abort({
    chatId,
  }: {
    chatId: string;
  }): void;

  TEST_ONLY: Record<string, never>;
};

export function useChatCompaction(_args: Record<string, never>): ChatCompactionAdapter {
  async function compactCurrentBranch({
    chatId,
    keepRecentMessages,
    instructionOverride,
  }: {
    chatId: string;
    keepRecentMessages: number;
    instructionOverride: string | undefined;
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
    chatId: string;
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
