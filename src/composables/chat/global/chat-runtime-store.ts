import { reactive } from 'vue';
import type { Chat } from '@/01-models/types';
import type { ChatId } from '@/01-models/ids';

export type ChatRuntimeTaskKind = 'title' | 'fetch' | 'process';

export type ChatRuntimeTaskKey = {
  kind: ChatRuntimeTaskKind,
  chatId: ChatId | undefined,
};

export type ActiveGenerationEntry = {
  controller: AbortController,
  chat: Chat,
};

export type ChatRuntimeStore = {
  activeGenerations: Map<ChatId, ActiveGenerationEntry>,
  activeTitleGenerations: Map<ChatId, AbortController>,
  externalGenerations: Set<ChatId>,

  startTask({
    key,
  }: {
    key: ChatRuntimeTaskKey,
  }): void,

  finishTask({
    key,
  }: {
    key: ChatRuntimeTaskKey,
  }): void,

  getTaskCount({
    key,
  }: {
    key: ChatRuntimeTaskKey,
  }): number,

  clearTask({
    key,
  }: {
    key: ChatRuntimeTaskKey,
  }): void,

  clearTasksForChat({
    chatId,
  }: {
    chatId: ChatId,
  }): void,

  isTaskRunning({
    chatId,
  }: {
    chatId: ChatId,
  }): boolean,

  isProcessing({
    chatId,
  }: {
    chatId: ChatId,
  }): boolean,

  isGeneratingTitle({
    chatId,
  }: {
    chatId: ChatId,
  }): boolean,

  setActiveGeneration({
    chatId,
    generation,
  }: {
    chatId: ChatId,
    generation: ActiveGenerationEntry,
  }): void,

  getActiveGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }): ActiveGenerationEntry | undefined,

  deleteActiveGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }): void,

  setExternalGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }): void,

  deleteExternalGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }): void,

  hasExternalGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }): boolean,

  setActiveTitleGeneration({
    chatId,
    controller,
  }: {
    chatId: ChatId,
    controller: AbortController,
  }): void,

  getActiveTitleGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }): AbortController | undefined,

  deleteActiveTitleGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }): void,

  clearActiveGenerations(): void,
  clearActiveTaskCounts(): void,

  TEST_ONLY: {
    activeTaskCounts: Map<string, number>,
  },
};

function serializeTaskKey({
  key,
}: {
  key: ChatRuntimeTaskKey,
}): string {
  return `${key.kind}:${key.chatId === undefined ? 'global' : idToRaw({ id: key.chatId })}`;
}

function isChatScopedTaskKey({
  serializedKey,
  chatId,
}: {
  serializedKey: string,
  chatId: ChatId,
}) {
  return serializedKey.endsWith(`:${idToRaw({ id: chatId })}`);
}

export function createChatRuntimeStore(): ChatRuntimeStore {
  const activeGenerations = reactive(new Map<ChatId, ActiveGenerationEntry>());
  const activeTitleGenerations = reactive(new Map<ChatId, AbortController>());
  const externalGenerations = reactive(new Set<ChatId>());
  const activeTaskCounts = reactive(new Map<string, number>());

  function startTask({
    key,
  }: {
    key: ChatRuntimeTaskKey,
  }) {
    const serializedKey = serializeTaskKey({ key });
    activeTaskCounts.set(serializedKey, (activeTaskCounts.get(serializedKey) || 0) + 1);
  }

  function finishTask({
    key,
  }: {
    key: ChatRuntimeTaskKey,
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
    key: ChatRuntimeTaskKey,
  }) {
    return activeTaskCounts.get(serializeTaskKey({ key })) || 0;
  }

  function clearTask({
    key,
  }: {
    key: ChatRuntimeTaskKey,
  }) {
    activeTaskCounts.delete(serializeTaskKey({ key }));
  }

  function clearTasksForChat({
    chatId,
  }: {
    chatId: ChatId,
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
    chatId: ChatId,
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
    chatId: ChatId,
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
    chatId: ChatId,
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
    chatId: ChatId,
    generation: ActiveGenerationEntry,
  }) {
    activeGenerations.set(chatId, generation);
  }

  function getActiveGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    return activeGenerations.get(chatId);
  }

  function deleteActiveGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    activeGenerations.delete(chatId);
  }

  function setExternalGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    externalGenerations.add(chatId);
  }

  function deleteExternalGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    externalGenerations.delete(chatId);
  }

  function hasExternalGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    return externalGenerations.has(chatId);
  }

  function setActiveTitleGeneration({
    chatId,
    controller,
  }: {
    chatId: ChatId,
    controller: AbortController,
  }) {
    activeTitleGenerations.set(chatId, controller);
  }

  function getActiveTitleGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    return activeTitleGenerations.get(chatId);
  }

  function deleteActiveTitleGeneration({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    activeTitleGenerations.delete(chatId);
  }

  function clearActiveGenerations() {
    activeGenerations.clear();
  }

  function clearActiveTaskCounts() {
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
import { idToRaw } from '@/01-models/ids';
