import { reactive } from 'vue';
import type { Chat } from '@/models/types';

export type ChatRuntimeTaskKind = 'title' | 'fetch' | 'process';

export type ChatRuntimeTaskKey = {
  kind: ChatRuntimeTaskKind;
  chatId: string | undefined;
};

export type ActiveGenerationEntry = {
  controller: AbortController;
  chat: Chat;
};

export type ChatRuntimeStore = {
  activeGenerations: Map<string, ActiveGenerationEntry>;
  activeTitleGenerations: Map<string, AbortController>;
  externalGenerations: Set<string>;

  startTask({
    key,
  }: {
    key: ChatRuntimeTaskKey;
  }): void;

  finishTask({
    key,
  }: {
    key: ChatRuntimeTaskKey;
  }): void;

  getTaskCount({
    key,
  }: {
    key: ChatRuntimeTaskKey;
  }): number;

  clearTask({
    key,
  }: {
    key: ChatRuntimeTaskKey;
  }): void;

  clearTasksForChat({
    chatId,
  }: {
    chatId: string;
  }): void;

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

  isGeneratingTitle({
    chatId,
  }: {
    chatId: string;
  }): boolean;

  setActiveGeneration({
    chatId,
    generation,
  }: {
    chatId: string;
    generation: ActiveGenerationEntry;
  }): void;

  getActiveGeneration({
    chatId,
  }: {
    chatId: string;
  }): ActiveGenerationEntry | undefined;

  deleteActiveGeneration({
    chatId,
  }: {
    chatId: string;
  }): void;

  setExternalGeneration({
    chatId,
  }: {
    chatId: string;
  }): void;

  deleteExternalGeneration({
    chatId,
  }: {
    chatId: string;
  }): void;

  hasExternalGeneration({
    chatId,
  }: {
    chatId: string;
  }): boolean;

  setActiveTitleGeneration({
    chatId,
    controller,
  }: {
    chatId: string;
    controller: AbortController;
  }): void;

  getActiveTitleGeneration({
    chatId,
  }: {
    chatId: string;
  }): AbortController | undefined;

  deleteActiveTitleGeneration({
    chatId,
  }: {
    chatId: string;
  }): void;

  clearActiveGenerations(_args: Record<never, never>): void;
  clearActiveTaskCounts(_args: Record<never, never>): void;

  TEST_ONLY: {
    activeTaskCounts: Map<string, number>;
  };
};

function serializeTaskKey({
  key,
}: {
  key: ChatRuntimeTaskKey;
}): string {
  return `${key.kind}:${key.chatId ?? 'global'}`;
}

function isChatScopedTaskKey({
  serializedKey,
  chatId,
}: {
  serializedKey: string;
  chatId: string;
}) {
  return serializedKey.endsWith(`:${chatId}`);
}

export function createChatRuntimeStore(_args: Record<never, never>): ChatRuntimeStore {
  const activeGenerations = reactive(new Map<string, ActiveGenerationEntry>());
  const activeTitleGenerations = reactive(new Map<string, AbortController>());
  const externalGenerations = reactive(new Set<string>());
  const activeTaskCounts = reactive(new Map<string, number>());

  function startTask({
    key,
  }: {
    key: ChatRuntimeTaskKey;
  }) {
    const serializedKey = serializeTaskKey({ key });
    activeTaskCounts.set(serializedKey, (activeTaskCounts.get(serializedKey) || 0) + 1);
  }

  function finishTask({
    key,
  }: {
    key: ChatRuntimeTaskKey;
  }) {
    const serializedKey = serializeTaskKey({ key });
    const nextValue = (activeTaskCounts.get(serializedKey) || 0) - 1;
    if (nextValue <= 0) {
      activeTaskCounts.delete(serializedKey);
      return;
    }
    activeTaskCounts.set(serializedKey, nextValue);
  }

  function getTaskCount({
    key,
  }: {
    key: ChatRuntimeTaskKey;
  }) {
    return activeTaskCounts.get(serializeTaskKey({ key })) || 0;
  }

  function clearTask({
    key,
  }: {
    key: ChatRuntimeTaskKey;
  }) {
    activeTaskCounts.delete(serializeTaskKey({ key }));
  }

  function clearTasksForChat({
    chatId,
  }: {
    chatId: string;
  }) {
    for (const serializedKey of Array.from(activeTaskCounts.keys())) {
      if (isChatScopedTaskKey({ serializedKey, chatId })) {
        activeTaskCounts.delete(serializedKey);
      }
    }
  }

  function isTaskRunning({
    chatId,
  }: {
    chatId: string;
  }) {
    if (activeGenerations.has(chatId) || externalGenerations.has(chatId)) {
      return true;
    }

    for (const [serializedKey, count] of activeTaskCounts.entries()) {
      if (count > 0 && isChatScopedTaskKey({ serializedKey, chatId })) {
        return true;
      }
    }
    return false;
  }

  function isProcessing({
    chatId,
  }: {
    chatId: string;
  }) {
    if (activeGenerations.has(chatId) || externalGenerations.has(chatId)) {
      return true;
    }

    return getTaskCount({
      key: {
        kind: 'process',
        chatId,
      },
    }) > 0;
  }

  function isGeneratingTitle({
    chatId,
  }: {
    chatId: string;
  }) {
    return getTaskCount({
      key: {
        kind: 'title',
        chatId,
      },
    }) > 0;
  }

  function setActiveGeneration({
    chatId,
    generation,
  }: {
    chatId: string;
    generation: ActiveGenerationEntry;
  }) {
    activeGenerations.set(chatId, generation);
  }

  function getActiveGeneration({
    chatId,
  }: {
    chatId: string;
  }) {
    return activeGenerations.get(chatId);
  }

  function deleteActiveGeneration({
    chatId,
  }: {
    chatId: string;
  }) {
    activeGenerations.delete(chatId);
  }

  function setExternalGeneration({
    chatId,
  }: {
    chatId: string;
  }) {
    externalGenerations.add(chatId);
  }

  function deleteExternalGeneration({
    chatId,
  }: {
    chatId: string;
  }) {
    externalGenerations.delete(chatId);
  }

  function hasExternalGeneration({
    chatId,
  }: {
    chatId: string;
  }) {
    return externalGenerations.has(chatId);
  }

  function setActiveTitleGeneration({
    chatId,
    controller,
  }: {
    chatId: string;
    controller: AbortController;
  }) {
    activeTitleGenerations.set(chatId, controller);
  }

  function getActiveTitleGeneration({
    chatId,
  }: {
    chatId: string;
  }) {
    return activeTitleGenerations.get(chatId);
  }

  function deleteActiveTitleGeneration({
    chatId,
  }: {
    chatId: string;
  }) {
    activeTitleGenerations.delete(chatId);
  }

  function clearActiveGenerations(_args: Record<never, never>) {
    activeGenerations.clear();
  }

  function clearActiveTaskCounts(_args: Record<never, never>) {
    activeTaskCounts.clear();
  }

  return {
    activeGenerations,
    activeTitleGenerations,
    externalGenerations,
    startTask,
    finishTask,
    getTaskCount,
    clearTask,
    clearTasksForChat,
    isTaskRunning,
    isProcessing,
    isGeneratingTitle,
    setActiveGeneration,
    getActiveGeneration,
    deleteActiveGeneration,
    setExternalGeneration,
    deleteExternalGeneration,
    hasExternalGeneration,
    setActiveTitleGeneration,
    getActiveTitleGeneration,
    deleteActiveTitleGeneration,
    clearActiveGenerations,
    clearActiveTaskCounts,
    TEST_ONLY: {
      activeTaskCounts,
    },
  };
}
