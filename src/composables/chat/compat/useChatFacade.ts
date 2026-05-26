import { toRaw, triggerRef, type ComputedRef } from 'vue';
import type { Chat, Settings } from '@/models/types';
import { generateId } from '@/utils/id';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import { storageService } from '@/services/storage';
import { transformersJsService } from '@/services/transformers-js';
import { getEnabledTools } from '@/services/tools/factory';
import { shouldIncludeWritableTmpMount } from '@/services/wesh/mount-policy';
import { useSettings } from '@/composables/useSettings';
import { useConfirm } from '@/composables/useConfirm';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { useStoragePersistence } from '@/composables/useStoragePersistence';
import { useImageGeneration } from '@/composables/useImageGeneration';
import { useToast } from '@/composables/useToast';
import { useChatTools } from '@/composables/useChatTools';
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences';
import { useChatDisplayFlow } from '@/composables/useChatDisplayFlow';
import { createChatControlService } from '@/composables/chat/services/chat-control-service';
import { createChatCurrentBridge } from '@/composables/chat/chat-current-bridge';
import {
  availableModels as sharedAvailableModels,
  chatDataStore,
  chatRuntimeStore,
  chatTmpDirectoryService,
  chatVolatileState,
  contextCompactProgress,
  contextCompactRuntime,
  creatingChat as sharedCreatingChat,
  currentChatGroupRef as _currentChatGroup,
  currentChatRef as _currentChat,
  ensureChatTmpDirectory,
  fetchingModels,
  generatingTitle,
  getContextCompactProgress,
  getChatTmpDirectory,
  getLiveChat,
  isGeneratingTitle,
  isProcessing,
  isTaskRunning,
  liveChatRegistry,
  loadData,
  registerLiveInstance,
  rootItems,
  setContextCompactProgress,
  streaming,
  unregisterLiveInstance,
  updateChatContent,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';
import { createChatDerivedState } from '@/composables/chat/chat-derived-state';
import { installChatBootstrap } from '@/composables/chat/chat-bootstrap';
import { createChatTestSupport } from '@/composables/chat/chat-test-support';
import { createContextCompactService } from '@/composables/chat/services/context-compact-service';
import { createChatGenerationService } from '@/composables/chat/services/chat-generation-service';
import { createChatHierarchyService } from '@/composables/chat/services/chat-hierarchy-service';
import { createChatHistoryService } from '@/composables/chat/services/chat-history-service';
import { createChatImageService } from '@/composables/chat/services/chat-image-service';
import { createChatLifecycleService } from '@/composables/chat/services/chat-lifecycle-service';
import { createChatMountService } from '@/composables/chat/services/chat-mount-service';
import { createChatMetadataService } from '@/composables/chat/services/chat-metadata-service';
import { createChatModelService } from '@/composables/chat/services/chat-model-service';
import { createChatOpenService } from '@/composables/chat/services/chat-open-service';
import { createChatRegenerationService } from '@/composables/chat/services/chat-regeneration-service';
import { createChatTitleService } from '@/composables/chat/services/chat-title-service';

export type { AddToastOptions } from '@/composables/chat/services/chat-lifecycle-service';

installChatBootstrap({
  registerBeforeUnload: (_args) => {
    const typeOfWindow = typeof window;
    switch (typeOfWindow) {
    case 'undefined':
      return undefined;
    case 'object':
    case 'boolean':
    case 'string':
    case 'number':
    case 'function':
    case 'symbol':
    case 'bigint': {
      const onBeforeUnload = () => {
        for (const item of chatRuntimeStore.activeGenerations.values()) {
          item.controller.abort();
        }
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      return () => {
        window.removeEventListener('beforeunload', onBeforeUnload);
      };
    }
    default: {
      const _ex: never = typeOfWindow;
      return _ex;
    }
    }
  },
  subscribeModelList: (_args) => {
    return transformersJsService.subscribeModelList(async () => {
      const { settings } = useSettings();
      const { addErrorEvent } = useGlobalEvents();
      const chatDerivedState = createChatDerivedState({
        currentChatRef: _currentChat,
        rootItems,
        getSettings: () => settings.value as Settings,
      });
      const chatModelService = createChatModelService({
        currentChatRef: _currentChat,
        liveChatRegistry,
        getChatGroups: () => chatDerivedState.chatGroups.value,
        getSettings: () => settings.value,
        triggerCurrentChat: ({ chatId }) => {
          if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
            triggerRef(_currentChat);
          }
        },
        runtimeStore: chatRuntimeStore,
        availableModelsRef: sharedAvailableModels,
        addErrorEvent,
      });
      const type = chatDerivedState.resolvedSettings.value?.endpointType;
      if (!type) return;

      switch (type) {
      case 'transformers_js':
        await chatModelService.fetchAvailableModels({
          chatId: _currentChat.value?.id,
          customEndpoint: undefined,
        });
        return;
      case 'openai':
      case 'ollama':
        return;
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled endpoint type: ${_ex}`);
      }
      }
    });
  },
});

// Compatibility facade for broad legacy callers.
// New feature-specific state and behavior should prefer scoped composables or
// services instead of extending this module further.
export function useChat() {
  const { settings } = useSettings();
  const { getNaidanSysfsMountSelection } = useChatWeshPreferences();
  const chatCurrentBridge = createChatCurrentBridge({
    currentChatRef: _currentChat,
    currentChatGroupRef: _currentChatGroup,
    liveChatRegistry,
    getLiveChat,
  });

  const chatDerivedState = createChatDerivedState({
    currentChatRef: _currentChat,
    rootItems,
    getSettings: () => settings.value as Settings,
  });
  const currentChat = chatCurrentBridge.currentChat;
  const currentChatGroup = chatCurrentBridge.currentChatGroup;
  const sidebarItems = chatDerivedState.sidebarItems;
  const chats = chatDerivedState.chats;
  const chatGroups = chatDerivedState.chatGroups;
  const resolvedSettings = chatDerivedState.resolvedSettings;
  const inheritedSettings = chatDerivedState.inheritedSettings;
  const activeMessages = chatDerivedState.activeMessages;
  const allMessages = chatDerivedState.allMessages;

  const chatMountService = createChatMountService({
    currentChatRef: _currentChat,
    currentChatGroupRef: _currentChatGroup,
    liveChatRegistry,
    ensureChatTmpDirectory,
    addMountToChatInStorage: ({ chatId, mount }) => storageService.addMountToChat({ chatId, mount }),
    removeMountFromChatInStorage: ({ chatId, volumeId }) => storageService.removeMountFromChat({ chatId, volumeId }),
    updateChatMountInStorage: ({ chatId, volumeId, readOnly }) => storageService.updateChatMount({ chatId, volumeId, readOnly }),
    addMountToChatGroupInStorage: ({ groupId, mount }) => storageService.addMountToChatGroup({ groupId, mount }),
    removeMountFromChatGroupInStorage: ({ groupId, volumeId }) => storageService.removeMountFromChatGroup({ groupId, volumeId }),
    updateChatGroupMountInStorage: ({ groupId, volumeId, mountPath, readOnly }) => storageService.updateChatGroupMount({ groupId, volumeId, mountPath, readOnly }),
  });
  const addMountToChat = chatMountService.addMountToChat;
  const removeMountFromChat = chatMountService.removeMountFromChat;
  const updateChatMount = chatMountService.updateChatMount;
  const addMountToChatGroup = chatMountService.addMountToChatGroup;
  const removeMountFromChatGroup = chatMountService.removeMountFromChatGroup;
  const updateChatGroupMount = chatMountService.updateChatGroupMount;

  const hasMountsForChat = chatDerivedState.hasMountsForChat;

  const { setToolEnabled, setCurrentChatId } = useChatTools();
  const chatOpenService = createChatOpenService({
    setCurrentChatId,
    setToolEnabled,
    hasMountsForChat,
    openChatInStore: ({ id, leafId }) => chatDataStore.openChat({ id, leafId }),
    openChatAtMessageInStore: ({ chatId, messageId }) => chatDataStore.openChatAtMessage({ chatId, messageId }),
    openChatGroupInStore: ({ id }) => {
      chatDataStore.openChatGroup({ id });
    },
  });
  const openChat = chatOpenService.openChat;
  const openChatAtMessage = chatOpenService.openChatAtMessage;
  const openChatGroup = chatOpenService.openChatGroup;

  const chatLifecycleService = createChatLifecycleService({
    currentChatRef: _currentChat,
    currentChatGroupRef: _currentChatGroup,
    creatingChatRef: sharedCreatingChat,
    registerLiveInstance,
    updateChatContent,
    updateChatMeta,
    updateHierarchy: updater => storageService.updateHierarchy(updater),
    loadData,
    loadChat: ({ id }) => storageService.loadChat({ id }),
    deleteChatFromStorage: ({ id }) => storageService.deleteChat({ id }),
    listChats: (_args) => storageService.listChats(),
    listChatGroups: (_args) => storageService.listChatGroups(),
    deleteChatGroupFromStorage: ({ id }) => storageService.deleteChatGroup({ id }),
    setCurrentChatId,
    addToast: (toast) => useToast().addToast(toast),
    openChat: ({ id }) => openChat({ id }),
    hasActiveGeneration: ({ chatId }) => chatRuntimeStore.activeGenerations.has(chatId),
    abortActiveGeneration: ({ chatId }) => {
      chatRuntimeStore.getActiveGeneration({ chatId })?.controller.abort();
      chatRuntimeStore.deleteActiveGeneration({ chatId });
    },
    clearTasksForChat: ({ chatId }) => {
      chatRuntimeStore.clearTasksForChat({ chatId });
    },
    clearActiveGenerations: (_args) => {
      for (const [, item] of chatRuntimeStore.activeGenerations.entries()) {
        item.controller.abort();
      }
      chatRuntimeStore.clearActiveGenerations({});
    },
    clearActiveTaskCounts: (_args) => {
      chatRuntimeStore.clearActiveTaskCounts({});
    },
    clearLiveChatRegistry: (_args) => {
      liveChatRegistry.clear();
    },
    clearChatTmpDirectories: (_args) => {
      chatTmpDirectoryService.clearChatTmpDirectories({});
    },
    deleteLiveChat: ({ chatId }) => {
      liveChatRegistry.delete(chatId);
    },
    deleteChatTmpDirectory: ({ chatId }) => {
      chatTmpDirectoryService.deleteChatTmpDirectory({ chatId });
    },
  });
  const createNewChat = chatLifecycleService.createNewChat;
  const deleteChat = chatLifecycleService.deleteChat;
  const deleteAllChats = chatLifecycleService.deleteAllChats;

  const chatMetadataService = createChatMetadataService({
    getChatTarget: ({ id }) => chatCurrentBridge.getChatTargetById({ id }),
    getCurrentChat: () => chatCurrentBridge.getCurrentChat({}),
    triggerCurrentChat: ({ chatId }) => chatCurrentBridge.triggerCurrentChat({ chatId }),
    updateChatMeta,
    loadData,
  });
  const renameChat = chatMetadataService.renameChat;
  const updateChatModel = chatMetadataService.updateChatModel;
  const updateChatGroupOverride = chatMetadataService.updateChatGroupOverride;
  const updateChatSettings = chatMetadataService.updateChatSettings;
  const getReasoningEffort = chatMetadataService.getReasoningEffort;

  const { addErrorEvent } = useGlobalEvents();
  const chatModelService = createChatModelService({
    currentChatRef: _currentChat,
    liveChatRegistry,
    getChatGroups: () => chatGroups.value,
    getSettings: () => settings.value,
    triggerCurrentChat: ({ chatId }) => chatCurrentBridge.triggerCurrentChat({ chatId }),
    runtimeStore: chatRuntimeStore,
    availableModelsRef: sharedAvailableModels,
    addErrorEvent,
  });
  const availableModels = chatModelService.availableModels;
  const fetchAvailableModels = chatModelService.fetchAvailableModels;

  const {
    isImageMode,
    toggleImageMode,
    getResolution,
    updateResolution,
    getCount,
    updateCount,
    getSteps,
    updateSteps,
    getSeed,
    updateSeed,
    getPersistAs,
    updatePersistAs,
    setImageModel,
    getSelectedImageModel,
    getSortedImageModels,
    performBase64Generation: _performGeneration,
    handleImageGeneration: _handleImageGeneration,
    sendImageRequest: _sendImageRequest,
    imageModeMap,
    imageResolutionMap,
    imageCountMap,
    imagePersistAsMap,
    imageProgressMap,
    imageModelOverrideMap,
  } = useImageGeneration();

  const chatImageService = createChatImageService({
    getCurrentChat: () => chatCurrentBridge.getCurrentChat({}),
    getLiveChat: ({ chat }) => getLiveChat({ chat }),
    getAvailableModels: () => availableModels.value,
    getStorageType: () => settings.value.storageType,
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({ chat, groups: chatGroups.value, globalSettings: settings.value });
      return {
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders ? [...resolved.endpointHttpHeaders] : undefined,
      };
    },
    performGeneration: _performGeneration,
    handleImageGenerationImpl: _handleImageGeneration,
    sendImageRequestImpl: _sendImageRequest,
    updateChatContent,
    triggerCurrentChat: ({ chatId }) => chatCurrentBridge.triggerCurrentChat({ chatId }),
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
    sendMessage: ({ chatId, content, parentId, attachments }) => {
      if (chatId === undefined) {
        return sendMessage({ content, parentId, attachments });
      }

      return sendMessageForChat({
        chatId,
        content,
        parentId,
        attachments,
        lmParameters: undefined,
      });
    },
  });
  const handleImageGeneration = chatImageService.handleImageGeneration;
  const sendImageRequestForChat = chatImageService.sendImageRequestForChat;
  const chatTitleService = createChatTitleService({
    getCurrentChatId: () => chatCurrentBridge.getCurrentChatId({}),
    getChatTarget: ({ chatId }) => chatCurrentBridge.getChatTargetByOptionalId({ chatId }),
    getLiveChat: ({ chat }) => getLiveChat({ chat }),
    registerLiveInstance,
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({ chat, groups: chatGroups.value, globalSettings: settings.value });
      return {
        endpointType: resolved.endpointType,
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders,
        modelId: resolved.modelId,
        titleModelId: resolved.titleModelId,
        lmParameters: resolved.lmParameters,
      };
    },
    updateChatMeta,
    loadData,
    triggerCurrentChat: ({ chatId }) => chatCurrentBridge.triggerCurrentChat({ chatId }),
    runtimeStore: chatRuntimeStore,
    getFallbackLanguage: (_args) => {
      const typeOfNavigator = typeof navigator;
      switch (typeOfNavigator) {
      case 'undefined':
        return 'en';
      case 'object':
      case 'boolean':
      case 'string':
      case 'number':
      case 'function':
      case 'symbol':
      case 'bigint':
        return navigator.language;
      default: {
        const _ex: never = typeOfNavigator;
        return _ex;
      }
      }
    },
  });
  const generateChatTitle = chatTitleService.generateChatTitle;
  const abortTitleGeneration = chatTitleService.abortTitleGeneration;
  const { enabledToolNames } = useChatTools();
  const chatGenerationService = createChatGenerationService({
    getCurrentChat: () => _currentChat.value,
    getChatTarget: ({ chatId }) => chatCurrentBridge.getChatTargetByOptionalId({ chatId }),
    getLiveChat,
    registerLiveInstance,
    isProcessing,
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
    triggerCurrentChat: ({ chatId }) => chatCurrentBridge.triggerCurrentChat({ chatId }),
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({ chat, groups: chatGroups.value, globalSettings: settings.value });
      return {
        endpointType: resolved.endpointType,
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders,
        modelId: resolved.modelId,
        lmParameters: resolved.lmParameters,
        systemPromptMessages: resolved.systemPromptMessages,
        autoTitleEnabled: resolved.autoTitleEnabled,
      };
    },
    fetchAvailableModels: ({ chatId }) => fetchAvailableModels({ chatId, customEndpoint: undefined }),
    canPersistBinary: () => storageService.canPersistBinary,
    persistAttachment: async ({ attachment }) => {
      switch (attachment.status) {
      case 'memory':
        if (storageService.canPersistBinary) {
          try {
            await storageService.saveFile(attachment.blob, attachment.binaryObjectId, attachment.originalName);
            return { ...attachment, status: 'persisted' };
          } catch {
            return attachment;
          }
        }
        return attachment;
      case 'persisted':
      case 'missing':
        return attachment;
      default: {
        const _ex: never = attachment;
        throw new Error(`Unhandled attachment status: ${_ex}`);
      }
      }
    },
    confirmTemporaryAttachments: async (_args) => {
      if (settings.value.heavyContentAlertDismissed !== false) {
        return true;
      }
      return await useConfirm().showConfirm({
        title: 'Attachments cannot be saved',
        message: 'You are using Local Storage, which has a 5MB limit. Attachments will be available during this session but will NOT be saved to your history. Switch to OPFS storage in Settings to enable permanent saving.',
        confirmButtonText: 'Continue anyway',
        cancelButtonText: 'Cancel',
      });
    },
    dismissHeavyContentAlert: (_args) => {
      useSettings().setHeavyContentAlertDismissed?.({ dismissed: true });
    },
    showOnboardingDraft: ({ url, type, models }) => {
      useSettings().setOnboardingDraft?.({ draft: { url: url || '', type, models, selectedModel: models[0] || '' } });
      useSettings().setIsOnboardingDismissed?.({ dismissed: false });
    },
    isImageMode,
    getSelectedImageModel,
    getResolution,
    getCount,
    getSteps,
    getSeed,
    getPersistAs,
    getAvailableModels: () => availableModels.value,
    reportMissingImageModel: async (_args) => {
      const { useGlobalEvents } = await import('@/composables/useGlobalEvents');
      const { addErrorEvent } = useGlobalEvents();
      addErrorEvent({ source: 'useChat:sendMessage', message: 'No image generation model found (starting with x/z-image-turbo:).' });
    },
    setActiveGeneration: ({ chatId, generation }) => {
      chatRuntimeStore.setActiveGeneration({ chatId, generation });
    },
    deleteActiveGeneration: ({ chatId }) => {
      chatRuntimeStore.deleteActiveGeneration({ chatId });
    },
    hasActiveGeneration: ({ chatId }) => chatRuntimeStore.activeGenerations.has(chatId),
    handleImageGeneration,
    loadBinaryObject: ({ id }) => storageService.getFile({ binaryObjectId: id }),
    persistToolContent: async ({ text, type, toolCallId }) => {
      const BINARY_THRESHOLD = 100 * 1024;
      if (text.length > BINARY_THRESHOLD) {
        const blob = new Blob([text], { type: 'text/plain' });
        const binaryId = generateId();
        await storageService.saveFile(blob, binaryId, `tool_${type}_${toolCallId}.txt`);
        return { type: 'binary_object', id: binaryId };
      }
      return { type: 'text', text };
    },
    updateChatContent,
    updateChatMeta,
    reloadAfterGenerationMetaUpdate: async (_args) => {
      await loadData({});
    },
    setVolatileAssistantError: chatVolatileState.setVolatileAssistantError,
    clearVolatileAssistantError: chatVolatileState.clearVolatileAssistantError,
    setVolatileToolOutput: chatVolatileState.setVolatileToolOutput,
    appendVolatileToolOutput: chatVolatileState.appendVolatileToolOutput,
    deleteVolatileToolOutput: chatVolatileState.deleteVolatileToolOutput,
    notifyGenerationStatus: ({ chatId, status }) => {
      storageService.notify({ type: 'chat_content_generation', id: chatId, status, timestamp: Date.now() });
    },
    getEnabledToolsForChat: async ({ chat }) => {
      const shellExecuteEnabled = enabledToolNames.value.includes('shell_execute');
      const chatTmpDirectory = shellExecuteEnabled && shouldIncludeWritableTmpMount({ storageType: settings.value.storageType })
        ? await ensureChatTmpDirectory({ chatId: chat.id })
        : undefined;
      const chatGroupMounts = chat.groupId
        ? (_currentChatGroup.value?.id === chat.groupId
          ? _currentChatGroup.value.mounts
          : (await storageService.loadChatGroup({ id: chat.groupId }))?.mounts)
        : undefined;
      return await getEnabledTools({
        enabledNames: enabledToolNames.value,
        settings: settings.value as unknown as Settings,
        chatGroupMounts,
        chatMounts: chat.mounts,
        chatId: chat.id,
        chatGroupId: chat.groupId ?? undefined,
        naidanSysfsVisibility: getNaidanSysfsMountSelection({ chatId: chat.id }),
        tmpHandle: chatTmpDirectory?.handle,
      });
    },
    requestPersistence: (_args) => {
      const { requestPersistence } = useStoragePersistence();
      requestPersistence();
    },
    showGenerationFailedToast: async ({ chat }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) {
        return;
      }
      try {
        const { useToast } = await import('@/composables/useToast');
        const { addToast } = useToast();
        addToast({
          message: `Generation failed in "${chat.title || 'New Chat'}"`,
          actionLabel: 'View',
          onAction: async () => {
            await openChat({ id: chat.id });
          },
        });
      } catch {
        // ignore
      }
    },
    generateChatTitle: ({ chatId, signal, titleModelIdOverride }) => generateChatTitle({
      chatId,
      signal,
      titleModelIdOverride,
    }),
    reorderSidebarChatAfterSend: ({ chatId }) => reorderSidebarChatAfterSend({ chatId }),
  });
  const generateResponse = chatGenerationService.generateResponse;
  const sendMessage = chatGenerationService.sendMessage;
  const sendMessageForChat = chatGenerationService.sendMessageForChat;
  const contextCompactService = createContextCompactService({
    getCurrentChat: () => chatCurrentBridge.getCurrentChat({}),
    getChatTarget: ({ chatId }) => chatCurrentBridge.getChatTargetByOptionalId({ chatId }),
    getLiveChat,
    isProcessing,
    registerLiveInstance,
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({ chat, groups: chatGroups.value, globalSettings: settings.value });
      return {
        endpointType: resolved.endpointType,
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders,
        modelId: resolved.modelId,
        lmParameters: resolved.lmParameters,
      };
    },
    getPromptMode: ({ chatId }) => {
      const mountSelection = getNaidanSysfsMountSelection({ chatId });
      switch (mountSelection) {
      case 'none':
        return 'without_message_ids';
      case 'current_chat_only':
      case 'current_chat_with_chat_group':
      case 'all_chats':
        return 'with_message_ids';
      default: {
        const _ex: never = mountSelection;
        throw new Error(`Unhandled naidan sysfs mount selection: ${_ex}`);
      }
      }
    },
    runtime: contextCompactRuntime,
    updateChatContent,
    updateChatMeta,
    triggerCurrentChat: ({ chatId }) => chatCurrentBridge.triggerCurrentChat({ chatId }),
    addErrorEvent,
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
  });
  const abortContextCompact = contextCompactService.abortContextCompact;
  const chatControlService = createChatControlService({
    currentChatRef: _currentChat,
    abortContextCompact,
    hasActiveGeneration: ({ chatId }) => chatRuntimeStore.activeGenerations.has(chatId),
    abortActiveGeneration: ({ chatId }) => {
      chatRuntimeStore.getActiveGeneration({ chatId })?.controller.abort();
    },
    hasExternalGeneration: ({ chatId }) => chatRuntimeStore.hasExternalGeneration({ chatId }),
    notifyAbortRequest: ({ chatId }) => {
      storageService.notify({ type: 'chat_content_generation', id: chatId, status: 'abort_request', timestamp: Date.now() });
    },
    abortTitleGeneration,
    compactCurrentBranchImpl: contextCompactService.compactCurrentBranch,
  });
  const abortChat = chatControlService.abortChat;
  const compactCurrentBranch = chatControlService.compactCurrentBranch;

  const chatHistoryService = createChatHistoryService({
    currentChatRef: _currentChat,
    liveChatRegistry,
    getLiveChat,
    registerLiveInstance,
    updateChatContent,
    updateChatMeta,
    updateHierarchy: updater => storageService.updateHierarchy(updater),
    loadData,
    openChat: ({ id }) => openChat({ id }),
    canPersistBinary: () => storageService.canPersistBinary,
    saveFile: ({ blob, binaryObjectId, originalName }) => storageService.saveFile(blob, binaryObjectId, originalName),
    isProcessing,
    abortChat,
    sendMessage: async ({ content, parentId, attachments, chatTarget, lmParameters }) => {
      await sendMessage({ content, parentId, attachments, chatTarget, lmParameters });
    },
    triggerCurrentChat: ({ chatId }) => chatCurrentBridge.triggerCurrentChat({ chatId }),
  });
  const forkChat = chatHistoryService.forkChat;
  const forkChatForChat = chatHistoryService.forkChatForChat;
  const editMessage = chatHistoryService.editMessage;
  const editMessageForChat = chatHistoryService.editMessageForChat;
  const switchVersion = chatHistoryService.switchVersion;
  const switchVersionForChat = chatHistoryService.switchVersionForChat;
  const getSiblings = chatHistoryService.getSiblings;

  const chatRegenerationService = createChatRegenerationService({
    getCurrentChat: () => chatCurrentBridge.getCurrentChat({}),
    getChatTarget: ({ chatId }) => chatCurrentBridge.getChatTargetByOptionalId({ chatId }),
    getLiveChat,
    registerLiveInstance,
    isProcessing,
    abortChat,
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
    updateChatContent,
    updateChatMeta,
    triggerCurrentChat: ({ chatId }) => chatCurrentBridge.triggerCurrentChat({ chatId }),
    generateResponse,
  });
  const regenerateMessage = chatRegenerationService.regenerateMessage;
  const regenerateMessageForChat = chatRegenerationService.regenerateMessageForChat;

  const toggleDebug = chatMetadataService.toggleDebug;
  const toggleDebugForChat = chatMetadataService.toggleDebugForChat;
  const updateReasoningEffort = chatMetadataService.updateReasoningEffort;
  const commitFullHistoryManipulation = chatHistoryService.commitFullHistoryManipulation;
  const generateImage = chatImageService.generateImage;
  const sendImageRequest = chatImageService.sendImageRequest;

  const chatHierarchyService = createChatHierarchyService({
    rootItems,
    currentChatRef: _currentChat,
    currentChatGroupRef: _currentChatGroup,
    getChatGroups: () => chatGroups.value,
    getSidebarSendMessageReorder: () => settings.value.experimental?.sidebarSendMessageReorder ?? 'disabled',
    replaceSidebarItems: chatDataStore.replaceSidebarItems,
    updateChatGroup: ({ id, updater }) => storageService.updateChatGroup(id, updater),
    deleteChatGroupFromStorage: ({ id }) => storageService.deleteChatGroup({ id }),
    updateHierarchy: updater => storageService.updateHierarchy(updater),
    loadData,
    deleteChat,
  });
  const createChatGroup = chatHierarchyService.createChatGroup;
  const deleteChatGroup = chatHierarchyService.deleteChatGroup;
  const setChatGroupCollapsed = chatHierarchyService.setChatGroupCollapsed;
  const duplicateChatGroup = chatHierarchyService.duplicateChatGroup;
  const renameChatGroup = chatHierarchyService.renameChatGroup;
  const updateChatGroupMetadata = chatHierarchyService.updateChatGroupMetadata;
  const persistSidebarStructure = chatHierarchyService.persistSidebarStructure;
  const reorderSidebarChatAfterSend = chatHierarchyService.reorderSidebarChatAfterSend;
  const moveChatToGroup = chatHierarchyService.moveChatToGroup;

  const chatTestSupport = createChatTestSupport({
    currentChatRef: _currentChat,
    currentChatGroupRef: _currentChatGroup,
    registerLiveInstance,
    setContextCompactProgress,
    clearLiveChatRegistryImpl: (_args) => {
      liveChatRegistry.clear();
    },
  });
  const __testOnlySetCurrentChat = chatTestSupport.__testOnlySetCurrentChat;
  const __testOnlySetCurrentChatGroup = chatTestSupport.__testOnlySetCurrentChatGroup;
  const __testOnlySetContextCompactProgress = chatTestSupport.__testOnlySetContextCompactProgress;
  const clearLiveChatRegistry = chatTestSupport.clearLiveChatRegistry;

  const clearActiveTaskCounts = (_params: Record<string, never>) => {
    chatRuntimeStore.clearActiveTaskCounts({});
  };

  const getVolatileToolOutput = chatVolatileState.getVolatileToolOutput;

  const {
    chatFlow,
    isThinkingActive,
    isWaitingResponse,
  } = useChatDisplayFlow({
    chat: currentChat as unknown as ComputedRef<Chat | null>,
    isProcessing,
  });

  return {
    rootItems, chats, chatGroups, sidebarItems, currentChat, currentChatGroup, resolvedSettings, inheritedSettings, activeMessages, allMessages, streaming, generatingTitle, availableModels, fetchingModels,
    imageModeMap, imageResolutionMap, imageCountMap, imagePersistAsMap, imageProgressMap, imageModelOverrideMap,
    isImageMode, toggleImageMode, getResolution, updateResolution, getCount, updateCount, getSteps, updateSteps, getSeed, updateSeed, getPersistAs, updatePersistAs, setImageModel, getSelectedImageModel, getSortedImageModels, getReasoningEffort, updateReasoningEffort,
    loadChats: loadData, fetchAvailableModels, createNewChat, openChat, openChatAtMessage, openChatGroup, deleteChat, deleteAllChats, renameChat, updateChatModel, updateChatGroupOverride, updateChatSettings, generateChatTitle, sendMessage, sendMessageForChat, regenerateMessage, regenerateMessageForChat, forkChat, forkChatForChat, editMessage, editMessageForChat, switchVersion, switchVersionForChat, getSiblings, toggleDebug, toggleDebugForChat, commitFullHistoryManipulation, generateImage, generateResponse, handleImageGeneration, sendImageRequest, sendImageRequestForChat, createChatGroup, deleteChatGroup, duplicateChatGroup, setChatGroupCollapsed, renameChatGroup, updateChatGroupMetadata, persistSidebarStructure, abortChat, abortTitleGeneration, updateChatMeta, updateChatContent, moveChatToGroup, addMountToChat, removeMountFromChat, updateChatMount, addMountToChatGroup, removeMountFromChatGroup, updateChatGroupMount, compactCurrentBranch, abortContextCompact, getContextCompactProgress,
    registerLiveInstance, unregisterLiveInstance, getLiveChat, isTaskRunning, isProcessing, isGeneratingTitle, ensureChatTmpDirectory, getChatTmpDirectory,
    getVolatileToolOutput,
    chatFlow, isThinkingActive, isWaitingResponse, contextCompactProgress,
    TEST_ONLY: {
      liveChatRegistry,
      activeGenerations: chatRuntimeStore.activeGenerations,
      activeTaskCounts: chatRuntimeStore.TEST_ONLY.activeTaskCounts,
      compactProgressByChat: contextCompactRuntime.TEST_ONLY.compactProgressByChat,
      activeContextCompactions: contextCompactRuntime.activeContextCompactions,
      chatTmpDirectories: chatTmpDirectoryService.TEST_ONLY.chatTmpDirectories,
      clearLiveChatRegistry,
      clearActiveTaskCounts,
      volatileToolOutputs: chatVolatileState.TEST_ONLY.volatileToolOutputs,
      __testOnlySetCurrentChat,
      __testOnlySetCurrentChatGroup,
      __testOnlySetContextCompactProgress,
    },
  };
}
