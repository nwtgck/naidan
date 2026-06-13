import { ref, toRaw, triggerRef } from 'vue';
import { type ContextCompactProgress } from '@/services/context-compact';
import { createChatDataStore } from './chat-data-store';
import { createChatRuntimeFacade } from './chat-runtime-facade';
import { createChatRuntimeStore } from './chat-runtime-store';
import { createChatVolatileState } from './chat-volatile-state';
import { createContextCompactRuntime } from './context-compact-runtime';
import {
  chatTmpDirectories,
  clearChatTmpDirectories,
  deleteChatTmpDirectory,
  ensureChatTmpDirectory,
  getChatTmpDirectory,
} from './chat-tmp-directory-store';

export const chatRuntimeStore = createChatRuntimeStore();
export const contextCompactRuntime = createContextCompactRuntime();
export const chatVolatileState = createChatVolatileState();
export const availableModels = ref<string[]>([]);
export const creatingChat = ref(false);

export function isTaskRunning({
  chatId,
}: {
  chatId: string;
}) {
  return chatRuntimeStore.isTaskRunning({ chatId });
}

export function isProcessing({
  chatId,
}: {
  chatId: string;
}) {
  return chatRuntimeStore.isProcessing({ chatId });
}

export function setContextCompactProgress({
  chatId,
  progress,
}: {
  chatId: string;
  progress: ContextCompactProgress;
}) {
  contextCompactRuntime.setProgress({ chatId, progress });
}

export function getContextCompactProgress({
  chatId,
}: {
  chatId: string | undefined;
}): ContextCompactProgress {
  return contextCompactRuntime.getProgress({ chatId });
}

export const chatDataStore = createChatDataStore({
  applyVolatileAssistantErrorsToChat: chatVolatileState.applyVolatileAssistantErrorsToChat,
  hasActiveGeneration: ({ chatId }) => chatRuntimeStore.activeGenerations.has(chatId),
  isTaskRunning,
  onExternalGenerationStarted: ({ chatId }) => {
    chatRuntimeStore.setExternalGeneration({ chatId });
  },
  onExternalGenerationStopped: ({ chatId }) => {
    chatRuntimeStore.deleteExternalGeneration({ chatId });
  },
  onExternalGenerationAbortRequest: ({ chatId }) => {
    chatRuntimeStore.getActiveGeneration({ chatId })?.controller.abort();
  },
  onMigration: () => {
    for (const item of chatRuntimeStore.activeGenerations.values()) item.controller.abort();
    chatRuntimeStore.clearActiveGenerations();
    chatRuntimeStore.clearActiveTaskCounts();
    clearChatTmpDirectories();
  },
});

export const rootItems = chatDataStore.rootItems;
export const currentChatRef = chatDataStore.currentChatRef;
export const currentChatGroupRef = chatDataStore.currentChatGroupRef;
export const liveChatRegistry = chatDataStore.liveChatRegistry;
export const registerLiveInstance = chatDataStore.registerLiveInstance;
export const unregisterLiveInstance = chatDataStore.unregisterLiveInstance;
export const getLiveChat = chatDataStore.getLiveChat;
export const getLiveChatById = chatDataStore.getLiveChatById;
export const getReadonlyChat = chatDataStore.getReadonlyChat;
export const loadData = chatDataStore.loadData;
export const updateChatContent = chatDataStore.updateChatContent;
export const updateChatMeta = chatDataStore.updateChatMeta;

export function getChatTargetByOptionalId({
  chatId,
}: {
  chatId: string | undefined;
}) {
  if (chatId === undefined) {
    return null;
  }

  return getLiveChatById({ chatId });
}

export function triggerCurrentChat({
  chatId,
}: {
  chatId: string;
}) {
  if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) {
    triggerRef(currentChatRef);
  }
}

export const chatRuntimeFacade = createChatRuntimeFacade({
  currentChatRef,
  runtimeStore: chatRuntimeStore,
  contextCompactRuntime,
});
export const streaming = chatRuntimeFacade.streaming;
export const generatingTitle = chatRuntimeFacade.generatingTitle;
export const fetchingModels = chatRuntimeFacade.fetchingModels;
export const contextCompactProgress = chatRuntimeFacade.contextCompactProgress;
export const isGeneratingTitle = chatRuntimeFacade.isGeneratingTitle;
export { chatTmpDirectories, clearChatTmpDirectories, deleteChatTmpDirectory, ensureChatTmpDirectory, getChatTmpDirectory };
