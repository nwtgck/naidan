import type { ContextCompactProgress } from '@/services/context-compact';
import { chatRuntimeStore, contextCompactRuntime } from '@/composables/chat/global/chat-core-singletons';

export function isChatProcessing({
  chatId,
}: {
  chatId: string;
}): boolean {
  return chatRuntimeStore.isProcessing({ chatId });
}

export function getChatContextCompactProgress({
  chatId,
}: {
  chatId: string;
}): ContextCompactProgress {
  return contextCompactRuntime.getProgress({ chatId });
}

export function isChatGeneratingTitle({
  chatId,
}: {
  chatId: string;
}): boolean {
  return chatRuntimeStore.activeTitleGenerations.has(chatId);
}
