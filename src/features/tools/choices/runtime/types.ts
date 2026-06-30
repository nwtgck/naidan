import type { ChatId, ToolChoicesRequestId } from '@/01-models/ids';

export type ChoicesSelection = {
  index: number,
};

export type ChoicesActiveRequest = {
  requestId: ToolChoicesRequestId,
  chatId: ChatId,
  prompt: string,
  choices: readonly string[],
};

export type RequestChoice = ({
  chatId,
  prompt,
  choices,
  signal,
}: {
  chatId: ChatId,
  prompt: string,
  choices: readonly string[],
  signal: AbortSignal | undefined,
}) => Promise<ChoicesSelection>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
