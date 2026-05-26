import { toRaw, triggerRef, type ComputedRef } from 'vue';
import type { Chat, EndpointType, Reasoning, Settings } from '@/models/types';
import { generateId } from '@/utils/id';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import { storageService } from '@/services/storage';
import { transformersJsService } from '@/services/transformers-js';
import { getEnabledTools } from '@/services/tools/factory';
import { shouldIncludeWritableTmpMount } from '@/services/wesh/mount-policy';
import { useSettings } from '@/composables/useSettings';
import { useConfirm } from '@/composables/useConfirm';
import { useStoragePersistence } from '@/composables/useStoragePersistence';
import { useImageGeneration } from '@/composables/useImageGeneration';
import { useChatTools } from '@/composables/useChatTools';
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences';
import { useChatDisplayFlow } from '@/composables/useChatDisplayFlow';
import { createChatControlService } from '@/composables/chat/services/chat-control-service';
import { createChatCurrentBridge } from '@/composables/chat/chat-current-bridge';
import {
  availableModels as sharedAvailableModels,
  chatRuntimeStore,
  chatTmpDirectories,
  chatVolatileState,
  contextCompactProgress,
  contextCompactRuntime,
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
import {
  abortContextCompactForChat,
  runCompactCurrentBranchForChat,
} from '@/composables/chat/chat-scoped/chat-compact-flow';
import {
  getReasoningEffortForChatId,
  renameChatById,
  toggleDebugForChatId,
  updateChatGroupOverrideById,
  updateChatModelById,
  updateChatSettingsById,
  updateReasoningEffortForChatId,
} from '@/composables/chat/chat-scoped/chat-metadata-helpers';
import {
  fetchAvailableModelsForChat,
  fetchAvailableModelsForEndpoint,
} from '@/composables/chat/chat-scoped/chat-model-helpers';
import {
  abortTitleGenerationForChat,
  generateChatTitleForChat,
} from '@/composables/chat/chat-scoped/chat-title-helpers';
import { createChatGenerationService } from '@/composables/chat/services/chat-generation-service';
import { createChatHistoryService } from '@/composables/chat/services/chat-history-service';
import { createChatImageService } from '@/composables/chat/services/chat-image-service';
import { createChatRegenerationService } from '@/composables/chat/services/chat-regeneration-service';
import type { AddToastOptions } from '@/composables/chat/ui/useChatLifecycle';
import { useChatLifecycle } from '@/composables/chat/ui/useChatLifecycle';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import { useChatOrganization } from '@/composables/chat/ui/useChatOrganization';
import { useSidebarStructure } from '@/composables/chat/ui/useSidebarStructure';

export type { AddToastOptions } from '@/composables/chat/ui/useChatLifecycle';

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
      const chatDerivedState = createChatDerivedState({
        currentChatRef: _currentChat,
        rootItems,
        getSettings: () => settings.value as Settings,
      });
      const type = chatDerivedState.resolvedSettings.value?.endpointType;
      if (!type) return;

      switch (type) {
      case 'transformers_js':
        await fetchAvailableModelsForChat({
          chatId: _currentChat.value?.id,
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
// Only add behavior here when it is required to preserve legacy API compatibility.
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

  async function addMountToChat({
    chatId,
    mount,
  }: {
    chatId: string;
    mount: import('@/models/types').Mount;
  }) {
    await storageService.addMountToChat({ chatId, mount });
    await ensureChatTmpDirectory({ chatId });

    const chat = liveChatRegistry.get(chatId);
    if (chat !== undefined) {
      chat.mounts = [...(chat.mounts ?? []), mount];
      if (_currentChat.value?.id === chatId) {
        triggerRef(_currentChat);
      }
    }
  }

  async function removeMountFromChat({
    chatId,
    volumeId,
  }: {
    chatId: string;
    volumeId: string;
  }) {
    await storageService.removeMountFromChat({ chatId, volumeId });

    const chat = liveChatRegistry.get(chatId);
    if (chat !== undefined) {
      chat.mounts = (chat.mounts ?? []).filter(mount => !(mount.type === 'volume' && mount.volumeId === volumeId));
      if (_currentChat.value?.id === chatId) {
        triggerRef(_currentChat);
      }
    }
  }

  async function updateChatMount({
    chatId,
    volumeId,
    readOnly,
  }: {
    chatId: string;
    volumeId: string;
    readOnly: boolean;
  }) {
    await storageService.updateChatMount({ chatId, volumeId, readOnly });

    const chat = liveChatRegistry.get(chatId);
    if (chat !== undefined) {
      chat.mounts = (chat.mounts ?? []).map(mount =>
        mount.type === 'volume' && mount.volumeId === volumeId ? { ...mount, readOnly } : mount
      );
      if (_currentChat.value?.id === chatId) {
        triggerRef(_currentChat);
      }
    }
  }

  async function addMountToChatGroup({
    groupId,
    mount,
  }: {
    groupId: string;
    mount: import('@/models/types').Mount;
  }) {
    await storageService.addMountToChatGroup({ groupId, mount });
    if (_currentChatGroup.value?.id === groupId) {
      _currentChatGroup.value.mounts = [...(_currentChatGroup.value.mounts ?? []), mount];
    }
  }

  async function removeMountFromChatGroup({
    groupId,
    volumeId,
  }: {
    groupId: string;
    volumeId: string;
  }) {
    await storageService.removeMountFromChatGroup({ groupId, volumeId });
    if (_currentChatGroup.value?.id === groupId) {
      _currentChatGroup.value.mounts = (_currentChatGroup.value.mounts ?? []).filter(
        mount => !(mount.type === 'volume' && mount.volumeId === volumeId)
      );
    }
  }

  async function updateChatGroupMount({
    groupId,
    volumeId,
    mountPath,
    readOnly,
  }: {
    groupId: string;
    volumeId: string;
    mountPath: string;
    readOnly: boolean;
  }) {
    await storageService.updateChatGroupMount({ groupId, volumeId, mountPath, readOnly });
    if (_currentChatGroup.value?.id === groupId) {
      _currentChatGroup.value.mounts = (_currentChatGroup.value.mounts ?? []).map(mount =>
        mount.type === 'volume' && mount.volumeId === volumeId ? { ...mount, mountPath, readOnly } : mount
      );
    }
  }

  const chatNavigation = useChatNavigation();
  const chatLifecycle = useChatLifecycle();
  const chatOrganization = useChatOrganization();
  const sidebarStructure = useSidebarStructure();

  async function openChat({
    id,
    leafId,
  }: {
    id: string;
    leafId?: string;
  }) {
    return await chatNavigation.openChat({
      chatId: id,
      leafId,
    });
  }

  async function openChatAtMessage({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }) {
    return await chatNavigation.openChatAtMessage({
      chatId,
      messageId,
    });
  }

  function openChatGroup({
    id,
  }: {
    id: string | null;
  }) {
    chatNavigation.openChatGroup({
      groupId: id,
    });
  }

  async function createNewChat({
    groupId,
    modelId,
    systemPrompt,
  }: {
    groupId: string | undefined;
    modelId: string | undefined;
    systemPrompt: Chat['systemPrompt'];
  }) {
    return await chatLifecycle.createNewChat({
      groupId,
      modelId,
      systemPrompt,
    });
  }

  async function deleteChat({
    id,
    injectAddToast,
  }: {
    id: string;
    injectAddToast?: ((toast: AddToastOptions) => string) | undefined;
  }) {
    await chatLifecycle.deleteChat({
      id,
      injectAddToast,
    });
  }

  async function deleteAllChats(_args: Record<never, never>) {
    await chatLifecycle.deleteAllChats({});
  }

  async function renameChat({
    id,
    newTitle,
  }: {
    id: string;
    newTitle: string;
  }) {
    await renameChatById({
      chatId: id,
      title: newTitle,
    });
  }

  async function updateChatModel({
    id,
    modelId,
  }: {
    id: string;
    modelId: string | undefined;
  }) {
    await updateChatModelById({
      chatId: id,
      modelId,
    });
  }

  async function updateChatGroupOverride({
    id,
    groupId,
  }: {
    id: string;
    groupId: string | null;
  }) {
    await updateChatGroupOverrideById({
      chatId: id,
      groupId,
    });
  }

  async function updateChatSettings({
    id,
    updates,
  }: {
    id: string;
    updates: Partial<Pick<Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    await updateChatSettingsById({
      chatId: id,
      updates,
    });
  }

  function getReasoningEffort({
    chatId,
  }: {
    chatId: string;
  }) {
    return getReasoningEffortForChatId({
      chatId,
    });
  }

  const availableModels = sharedAvailableModels;

  async function fetchAvailableModels({
    chatId,
    customEndpoint,
  }: {
    chatId: string | undefined;
    customEndpoint?: {
      type: EndpointType;
      url: string;
      headers: readonly (readonly [string, string])[] | undefined;
    } | undefined;
  }) {
    if (customEndpoint !== undefined) {
      return await fetchAvailableModelsForEndpoint({
        endpointType: customEndpoint.type,
        endpointUrl: customEndpoint.url,
        endpointHttpHeaders: customEndpoint.headers ? customEndpoint.headers.map(([name, value]) => [name, value]) : undefined,
        errorSource: 'useChat:fetchAvailableModels',
      });
    }

    return await fetchAvailableModelsForChat({
      chatId,
    });
  }

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
  async function generateChatTitle({
    chatId,
    signal,
    titleModelIdOverride,
  }: {
    chatId: string | undefined;
    signal: AbortSignal | undefined;
    titleModelIdOverride: string | undefined;
  }) {
    if (chatId === undefined) {
      return undefined;
    }

    return await generateChatTitleForChat({
      chatId,
      signal,
      titleModelIdOverride,
    });
  }

  function abortTitleGeneration({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    abortTitleGenerationForChat({
      chatId: chatId ?? chatCurrentBridge.getCurrentChatId({}) ?? undefined,
    });
  }
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

  function abortContextCompact({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    const targetChatId = chatId ?? chatCurrentBridge.getCurrentChatId({}) ?? undefined;
    abortContextCompactForChat({ chatId: targetChatId });
  }

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
    compactCurrentBranchImpl: async ({
      keepRecentMessages,
      instructionOverride,
    }) => {
      const currentChatId = chatCurrentBridge.getCurrentChatId({}) ?? undefined;
      if (currentChatId === undefined) {
        return { status: 'skipped' as const };
      }

      return await runCompactCurrentBranchForChat({
        chatId: currentChatId,
        keepRecentMessages,
        instructionOverride,
      });
    },
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

  async function toggleDebug(_args: Record<never, never>) {
    const currentChatId = chatCurrentBridge.getCurrentChatId({});
    if (currentChatId === null) {
      return;
    }

    await toggleDebugForChatId({
      chatId: currentChatId,
    });
  }

  async function toggleDebugForChat({
    chatId,
  }: {
    chatId: string;
  }) {
    await toggleDebugForChatId({
      chatId,
    });
  }

  async function updateReasoningEffort({
    chatId,
    effort,
  }: {
    chatId: string;
    effort: Reasoning['effort'];
  }) {
    await updateReasoningEffortForChatId({
      chatId,
      effort,
    });
  }
  const commitFullHistoryManipulation = chatHistoryService.commitFullHistoryManipulation;
  const generateImage = chatImageService.generateImage;
  const sendImageRequest = chatImageService.sendImageRequest;

  const createChatGroup = chatOrganization.createChatGroup;
  const deleteChatGroup = chatOrganization.deleteChatGroup;
  const duplicateChatGroup = chatOrganization.duplicateChatGroup;
  const renameChatGroup = chatOrganization.renameChatGroup;
  const updateChatGroupMetadata = chatOrganization.updateChatGroupMetadata;
  const reorderSidebarChatAfterSend = chatOrganization.reorderSidebarChatAfterSend;
  const moveChatToGroup = chatOrganization.moveChatToGroup;
  const setChatGroupCollapsed = sidebarStructure.setChatGroupCollapsed;
  const persistSidebarStructure = sidebarStructure.persistSidebarStructure;

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
      chatTmpDirectories,
      clearLiveChatRegistry,
      clearActiveTaskCounts,
      volatileToolOutputs: chatVolatileState.TEST_ONLY.volatileToolOutputs,
      __testOnlySetCurrentChat,
      __testOnlySetCurrentChatGroup,
      __testOnlySetContextCompactProgress,
    },
  };
}
