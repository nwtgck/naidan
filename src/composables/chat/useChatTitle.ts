import {
  abortTitleGenerationForChat,
  generateChatTitleForChat,
} from '@/composables/chat/chat-scoped/chat-title-flow';

export type ChatTitleCommandsAdapter = {
  generateTitle({
    chatId,
    titleModelIdOverride,
    signal,
  }: {
    chatId: string;
    titleModelIdOverride: string | undefined;
    signal: AbortSignal | undefined;
  }): Promise<string | null | undefined>;

  abortTitleGeneration({
    chatId,
  }: {
    chatId: string;
  }): void;

  TEST_ONLY: Record<never, never>;
};

export function useChatTitle(): ChatTitleCommandsAdapter {
  async function generateTitle({
    chatId,
    titleModelIdOverride,
    signal,
  }: {
    chatId: string;
    titleModelIdOverride: string | undefined;
    signal: AbortSignal | undefined;
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
    chatId: string;
  }): void {
    abortTitleGenerationForChat({ chatId });
  }

  return {
    generateTitle,
    abortTitleGeneration,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
