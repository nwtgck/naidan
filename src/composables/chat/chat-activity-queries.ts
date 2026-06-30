import type { ContextCompactProgress } from '@/logic/context-compact';
import type { ChatId } from '@/01-models/ids';
import { chatRuntimeStore, contextCompactRuntime } from '@/composables/chat/global/chat-core-singletons';

export function isChatProcessing({
  chatId,
}: {
  chatId: ChatId,
}): boolean {
  return chatRuntimeStore.isProcessing({ chatId });
}

export function isChatTaskRunning({
  chatId,
}: {
  chatId: ChatId,
}): boolean {
  return chatRuntimeStore.isTaskRunning({ chatId });
}

export function getChatContextCompactProgress({
  chatId,
}: {
  chatId: ChatId,
}): ContextCompactProgress {
  return contextCompactRuntime.getProgress({ chatId });
}

export function isChatGeneratingTitle({
  chatId,
}: {
  chatId: ChatId,
}): boolean {
  return chatRuntimeStore.activeTitleGenerations.has(chatId);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
