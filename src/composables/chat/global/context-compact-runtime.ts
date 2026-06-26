import { reactive } from 'vue';
import type { ContextCompactProgress } from '@/services/context-compact';
import type { ChatId } from '@/models/ids';

export type ContextCompactRuntime = {
  activeContextCompactions: Map<ChatId, AbortController>,

  setActiveContextCompaction({
    chatId,
    controller,
  }: {
    chatId: ChatId,
    controller: AbortController,
  }): void,

  getActiveContextCompaction({
    chatId,
  }: {
    chatId: ChatId,
  }): AbortController | undefined,

  clearActiveContextCompaction({
    chatId,
    controller,
  }: {
    chatId: ChatId,
    controller: AbortController | undefined,
  }): void,

  setProgress({
    chatId,
    progress,
  }: {
    chatId: ChatId,
    progress: ContextCompactProgress,
  }): void,

  getProgress({
    chatId,
  }: {
    chatId: ChatId | undefined,
  }): ContextCompactProgress,

  TEST_ONLY: {
    compactProgressByChat: Map<ChatId, ContextCompactProgress>,
    compactProgressResetTimers: Map<ChatId, ReturnType<typeof globalThis.setTimeout>>,
  },
};

export function createContextCompactRuntime(): ContextCompactRuntime {
  const compactProgressByChat = reactive(new Map<ChatId, ContextCompactProgress>());
  const compactProgressResetTimers = reactive(new Map<ChatId, ReturnType<typeof globalThis.setTimeout>>());
  const activeContextCompactions = reactive(new Map<ChatId, AbortController>());

  function clearProgressResetTimer({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    const existingTimer = compactProgressResetTimers.get(chatId);
    if (existingTimer === undefined) return;
    globalThis.clearTimeout(existingTimer);
    compactProgressResetTimers.delete(chatId);
  }

  function setProgress({
    chatId,
    progress,
  }: {
    chatId: ChatId,
    progress: ContextCompactProgress,
  }) {
    clearProgressResetTimer({ chatId });
    compactProgressByChat.set(chatId, progress);

    switch (progress.phase) {
    case 'complete':
    case 'failed':
    case 'aborted': {
      const timerId = globalThis.setTimeout(() => {
        if (compactProgressByChat.get(chatId)?.phase === progress.phase) {
          compactProgressByChat.delete(chatId);
        }
        compactProgressResetTimers.delete(chatId);
      }, 400);
      compactProgressResetTimers.set(chatId, timerId);
      return;
    }
    case 'idle':
    case 'preparing':
    case 'building_request':
    case 'requesting_model':
    case 'receiving_compact':
    case 'applying_branch':
      return;
    default: {
      const _ex: never = progress;
      throw new Error(`Unhandled context compact progress: ${_ex}`);
    }
    }
  }

  function getProgress({
    chatId,
  }: {
    chatId: ChatId | undefined,
  }): ContextCompactProgress {
    if (chatId === undefined) {
      return { phase: 'idle' };
    }

    return compactProgressByChat.get(chatId) ?? { phase: 'idle' };
  }

  function setActiveContextCompaction({
    chatId,
    controller,
  }: {
    chatId: ChatId,
    controller: AbortController,
  }) {
    activeContextCompactions.set(chatId, controller);
  }

  function getActiveContextCompaction({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    return activeContextCompactions.get(chatId);
  }

  function clearActiveContextCompaction({
    chatId,
    controller,
  }: {
    chatId: ChatId,
    controller: AbortController | undefined,
  }) {
    if (controller === undefined) {
      activeContextCompactions.delete(chatId);
      return;
    }
    if (activeContextCompactions.get(chatId) === controller) {
      activeContextCompactions.delete(chatId);
    }
  }

  return {
    activeContextCompactions,
    setActiveContextCompaction,
    getActiveContextCompaction,
    clearActiveContextCompaction,
    setProgress,
    getProgress,
    TEST_ONLY: {
      compactProgressByChat,
      compactProgressResetTimers,
    },
  };
}
