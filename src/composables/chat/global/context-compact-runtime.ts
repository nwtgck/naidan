import { reactive } from 'vue';
import type { ContextCompactProgress } from '@/services/context-compact';

export type ContextCompactRuntime = {
  activeContextCompactions: Map<string, AbortController>;

  setActiveContextCompaction({
    chatId,
    controller,
  }: {
    chatId: string;
    controller: AbortController;
  }): void;

  getActiveContextCompaction({
    chatId,
  }: {
    chatId: string;
  }): AbortController | undefined;

  clearActiveContextCompaction({
    chatId,
    controller,
  }: {
    chatId: string;
    controller: AbortController | undefined;
  }): void;

  setProgress({
    chatId,
    progress,
  }: {
    chatId: string;
    progress: ContextCompactProgress;
  }): void;

  getProgress({
    chatId,
  }: {
    chatId: string | undefined;
  }): ContextCompactProgress;

  TEST_ONLY: {
    compactProgressByChat: Map<string, ContextCompactProgress>;
    compactProgressResetTimers: Map<string, ReturnType<typeof globalThis.setTimeout>>;
  };
};

export function createContextCompactRuntime(_args: Record<never, never>): ContextCompactRuntime {
  const compactProgressByChat = reactive(new Map<string, ContextCompactProgress>());
  const compactProgressResetTimers = reactive(new Map<string, ReturnType<typeof globalThis.setTimeout>>());
  const activeContextCompactions = reactive(new Map<string, AbortController>());

  function clearProgressResetTimer({
    chatId,
  }: {
    chatId: string;
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
    chatId: string;
    progress: ContextCompactProgress;
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
    chatId: string | undefined;
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
    chatId: string;
    controller: AbortController;
  }) {
    activeContextCompactions.set(chatId, controller);
  }

  function getActiveContextCompaction({
    chatId,
  }: {
    chatId: string;
  }) {
    return activeContextCompactions.get(chatId);
  }

  function clearActiveContextCompaction({
    chatId,
    controller,
  }: {
    chatId: string;
    controller: AbortController | undefined;
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
