import { computed, toRaw, type ComputedRef, type Ref } from 'vue';
import type { Chat } from '@/models/types';
import type { ContextCompactProgress } from '@/services/context-compact';
import type { ContextCompactRuntime } from './context-compact-runtime';
import type { ChatRuntimeStore } from './chat-runtime-store';

export type ChatRuntimeFacade = {
  streaming: ComputedRef<boolean>;
  generatingTitle: ComputedRef<boolean>;
  fetchingModels: ComputedRef<boolean>;
  contextCompactProgress: ComputedRef<ContextCompactProgress>;

  isGeneratingTitle({
    chatId,
  }: {
    chatId: string;
  }): boolean;

  isTaskRunning({
    chatId,
  }: {
    chatId: string;
  }): boolean;

  isProcessing({
    chatId,
  }: {
    chatId: string;
  }): boolean;

  setContextCompactProgress({
    chatId,
    progress,
  }: {
    chatId: string;
    progress: ContextCompactProgress;
  }): void;

  getContextCompactProgress({
    chatId,
  }: {
    chatId: string | undefined;
  }): ContextCompactProgress;

  clearActiveTaskCounts(): void;
};

export function createChatRuntimeFacade({
  currentChatRef,
  runtimeStore,
  contextCompactRuntime,
}: {
  currentChatRef: Ref<Chat | null>;
  runtimeStore: ChatRuntimeStore;
  contextCompactRuntime: ContextCompactRuntime;
}): ChatRuntimeFacade {
  const streaming = computed(() => runtimeStore.activeGenerations.size > 0 || runtimeStore.externalGenerations.size > 0);

  function isGeneratingTitle({
    chatId,
  }: {
    chatId: string;
  }) {
    return runtimeStore.isGeneratingTitle({ chatId });
  }

  const generatingTitle = computed(() => {
    if (!currentChatRef.value) return false;
    return isGeneratingTitle({ chatId: toRaw(currentChatRef.value).id });
  });

  function getContextCompactProgress({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    return contextCompactRuntime.getProgress({ chatId });
  }

  const contextCompactProgress = computed<ContextCompactProgress>(() => {
    return getContextCompactProgress({
      chatId: currentChatRef.value ? toRaw(currentChatRef.value).id : undefined,
    });
  });

  const fetchingModels = computed(() => {
    if (runtimeStore.getTaskCount({ key: { kind: 'fetch', chatId: undefined } }) > 0) return true;
    if (!currentChatRef.value) return false;
    return runtimeStore.getTaskCount({
      key: {
        kind: 'fetch',
        chatId: toRaw(currentChatRef.value).id,
      },
    }) > 0;
  });

  function isTaskRunning({
    chatId,
  }: {
    chatId: string;
  }) {
    return runtimeStore.isTaskRunning({ chatId });
  }

  function isProcessing({
    chatId,
  }: {
    chatId: string;
  }) {
    return runtimeStore.isProcessing({ chatId });
  }

  function setContextCompactProgress({
    chatId,
    progress,
  }: {
    chatId: string;
    progress: ContextCompactProgress;
  }) {
    contextCompactRuntime.setProgress({ chatId, progress });
  }

  function clearActiveTaskCounts() {
    runtimeStore.clearActiveTaskCounts();
  }

  return {
    streaming,
    generatingTitle,
    fetchingModels,
    contextCompactProgress,
    isGeneratingTitle,
    isTaskRunning,
    isProcessing,
    setContextCompactProgress,
    getContextCompactProgress,
    clearActiveTaskCounts,
  };
}
