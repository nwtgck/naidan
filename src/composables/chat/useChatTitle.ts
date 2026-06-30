import {
  abortTitleGenerationForChat,
  generateChatTitleForChat,
} from '@/composables/chat/chat-scoped/chat-title-flow';
import type { ChatId } from '@/01-models/ids';

export type ChatTitleCommandsAdapter = {
  generateTitle({
    chatId,
    titleModelIdOverride,
    signal,
  }: {
    chatId: ChatId,
    titleModelIdOverride: string | undefined,
    signal: AbortSignal | undefined,
  }): Promise<string | null | undefined>,

  abortTitleGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }): void,

  TEST_ONLY: Record<never, never>,
};

export function useChatTitle(): ChatTitleCommandsAdapter {
  async function generateTitle({
    chatId,
    titleModelIdOverride,
    signal,
  }: {
    chatId: ChatId,
    titleModelIdOverride: string | undefined,
    signal: AbortSignal | undefined,
  }): Promise<string | null | undefined> {
    return await generateChatTitleForChat({
      chatId,
      titleModelIdOverride,
      signal,
    });
  }

  function abortTitleGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }): void {
    abortTitleGenerationForChat({ chatId });
  }

  return {
    generateTitle,
    abortTitleGeneration,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
