import type { Settings } from '@/models/types';
import { storageService } from '@/services/storage';
import { useChatTools } from '@/composables/useChatTools';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { useSettings } from '@/composables/useSettings';
import { useToast } from '@/composables/useToast';
import { createChatCurrentBridge } from '@/composables/chat/chat-current-bridge';
import { createChatDerivedState } from '@/composables/chat/chat-derived-state';
import {
  availableModels,
  chatDataStore,
  chatRuntimeStore,
  chatTmpDirectoryService,
  creatingChat,
  currentChatGroupRef,
  currentChatRef,
  ensureChatTmpDirectory,
  getLiveChat,
  liveChatRegistry,
  loadData,
  registerLiveInstance,
  rootItems,
  updateChatContent,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';
import { createChatHierarchyService } from '@/composables/chat/services/chat-hierarchy-service';
import { createChatLifecycleService } from '@/composables/chat/services/chat-lifecycle-service';
import { createChatMetadataService } from '@/composables/chat/services/chat-metadata-service';
import { createChatModelService } from '@/composables/chat/services/chat-model-service';
import { createChatMountService } from '@/composables/chat/services/chat-mount-service';
import { createChatOpenService } from '@/composables/chat/services/chat-open-service';

export function useChatUiServices(_args: Record<never, never>) {
  const { settings } = useSettings();
  const { addToast } = useToast();
  const { addErrorEvent } = useGlobalEvents();
  const { setCurrentChatId, setToolEnabled } = useChatTools();

  const currentBridge = createChatCurrentBridge({
    currentChatRef,
    currentChatGroupRef,
    liveChatRegistry,
    getLiveChat,
  });
  const derivedState = createChatDerivedState({
    currentChatRef,
    rootItems,
    getSettings: () => settings.value as Settings,
  });
  const openService = createChatOpenService({
    setCurrentChatId,
    setToolEnabled,
    hasMountsForChat: derivedState.hasMountsForChat,
    openChatInStore: ({ id, leafId }) => chatDataStore.openChat({ id, leafId }),
    openChatAtMessageInStore: ({ chatId, messageId }) => chatDataStore.openChatAtMessage({ chatId, messageId }),
    openChatGroupInStore: ({ id }) => {
      chatDataStore.openChatGroup({ id });
    },
  });
  const lifecycleService = createChatLifecycleService({
    currentChatRef,
    currentChatGroupRef,
    creatingChatRef: creatingChat,
    registerLiveInstance,
    updateChatContent,
    updateChatMeta,
    updateHierarchy: updater => storageService.updateHierarchy(updater),
    loadData,
    loadChat: ({ id }) => storageService.loadChat({ id }),
    deleteChatFromStorage: ({ id }) => storageService.deleteChat({ id }),
    listChats: (_innerArgs) => storageService.listChats(),
    listChatGroups: (_innerArgs) => storageService.listChatGroups(),
    deleteChatGroupFromStorage: ({ id }) => storageService.deleteChatGroup({ id }),
    setCurrentChatId,
    addToast,
    openChat: ({ id }) => openService.openChat({ id, leafId: undefined }),
    hasActiveGeneration: ({ chatId }) => chatRuntimeStore.activeGenerations.has(chatId),
    abortActiveGeneration: ({ chatId }) => {
      chatRuntimeStore.getActiveGeneration({ chatId })?.controller.abort();
      chatRuntimeStore.deleteActiveGeneration({ chatId });
    },
    clearTasksForChat: ({ chatId }) => {
      chatRuntimeStore.clearTasksForChat({ chatId });
    },
    clearActiveGenerations: (_innerArgs) => {
      for (const [, item] of chatRuntimeStore.activeGenerations.entries()) {
        item.controller.abort();
      }
      chatRuntimeStore.clearActiveGenerations({});
    },
    clearActiveTaskCounts: (_innerArgs) => {
      chatRuntimeStore.clearActiveTaskCounts({});
    },
    clearLiveChatRegistry: (_innerArgs) => {
      liveChatRegistry.clear();
    },
    clearChatTmpDirectories: (_innerArgs) => {
      chatTmpDirectoryService.clearChatTmpDirectories({});
    },
    deleteLiveChat: ({ chatId }) => {
      liveChatRegistry.delete(chatId);
    },
    deleteChatTmpDirectory: ({ chatId }) => {
      chatTmpDirectoryService.deleteChatTmpDirectory({ chatId });
    },
  });
  const metadataService = createChatMetadataService({
    getChatTarget: ({ id }) => currentBridge.getChatTargetById({ id }),
    getCurrentChat: () => currentBridge.getCurrentChat({}),
    triggerCurrentChat: ({ chatId }) => currentBridge.triggerCurrentChat({ chatId }),
    updateChatMeta,
    loadData,
  });
  const hierarchyService = createChatHierarchyService({
    rootItems,
    currentChatRef,
    currentChatGroupRef,
    getChatGroups: () => derivedState.chatGroups.value,
    getSidebarSendMessageReorder: () => settings.value.experimental?.sidebarSendMessageReorder ?? 'disabled',
    replaceSidebarItems: chatDataStore.replaceSidebarItems,
    updateChatGroup: ({ id, updater }) => storageService.updateChatGroup(id, updater),
    deleteChatGroupFromStorage: ({ id }) => storageService.deleteChatGroup({ id }),
    updateHierarchy: updater => storageService.updateHierarchy(updater),
    loadData,
    deleteChat: ({ id, injectAddToast }) => lifecycleService.deleteChat({ id, injectAddToast }),
  });
  const mountService = createChatMountService({
    currentChatRef,
    currentChatGroupRef,
    liveChatRegistry,
    ensureChatTmpDirectory,
    addMountToChatInStorage: ({ chatId, mount }) => storageService.addMountToChat({ chatId, mount }),
    removeMountFromChatInStorage: ({ chatId, volumeId }) => storageService.removeMountFromChat({ chatId, volumeId }),
    updateChatMountInStorage: ({ chatId, volumeId, readOnly }) => storageService.updateChatMount({ chatId, volumeId, readOnly }),
    addMountToChatGroupInStorage: ({ groupId, mount }) => storageService.addMountToChatGroup({ groupId, mount }),
    removeMountFromChatGroupInStorage: ({ groupId, volumeId }) => storageService.removeMountFromChatGroup({ groupId, volumeId }),
    updateChatGroupMountInStorage: ({ groupId, volumeId, mountPath, readOnly }) =>
      storageService.updateChatGroupMount({ groupId, volumeId, mountPath, readOnly }),
  });
  const modelService = createChatModelService({
    currentChatRef,
    liveChatRegistry,
    getChatGroups: () => derivedState.chatGroups.value,
    getSettings: () => settings.value,
    triggerCurrentChat: ({ chatId }) => currentBridge.triggerCurrentChat({ chatId }),
    runtimeStore: chatRuntimeStore,
    availableModelsRef: availableModels,
    addErrorEvent,
  });

  return {
    currentBridge,
    derivedState,
    openService,
    lifecycleService,
    metadataService,
    hierarchyService,
    mountService,
    modelService,
    availableModels,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
