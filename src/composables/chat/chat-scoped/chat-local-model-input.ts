import { shallowRef } from 'vue';
import type { ChatId } from '@/01-models/ids';
import type { ErrorCode, LocalModel } from '@/features/llama-cpp-browser/types';

export type ChatLocalModelOperation = {
  id: number,
  phase: 'reading' | 'choosing' | 'downloading' | 'committing' | 'cancelling' | 'error',
  candidates: readonly LocalModel[],
  model: LocalModel | undefined,
  error: ErrorCode | 'not-empty' | undefined,
  downloadJobId: number | undefined,
};
export type ChatLocalModelInput = {
  chatId: ChatId,
  owner: object,
  binding: 'empty-chat' | 'chat',
  state: ChatLocalModelOperation,
  controller: AbortController,
  isStorageCurrent(): boolean,
  run(): Promise<void>,
  pending: Promise<void> | undefined,
};

// The input operation itself is also send admission state; no second guard or
// preparation epoch is needed. It ends after the normal session is registered.
export const chatLocalModelInputs = shallowRef(new Map<ChatId, ChatLocalModelInput>());
export const TEST_ONLY = {
};
