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
