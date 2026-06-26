import type { ContextCompactProgress } from '@/services/context-compact';
import type { ChatId } from '@/models/ids';
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
