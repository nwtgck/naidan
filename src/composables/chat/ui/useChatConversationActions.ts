import type { Attachment, LmParameters, MessageNode, Settings } from '@/models/types';
import { storageService } from '@/services/storage';
import { getEnabledTools } from '@/services/tools/factory';
import { shouldIncludeWritableTmpMount } from '@/services/wesh/mount-policy';
import { useConfirm } from '@/composables/useConfirm';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { useImageGeneration } from '@/composables/useImageGeneration';
import { useSettings } from '@/composables/useSettings';
import { useStoragePersistence } from '@/composables/useStoragePersistence';
import { useToast } from '@/composables/useToast';
import { useChatTools } from '@/composables/useChatTools';
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences';
import {
  chatRuntimeStore,
  chatVolatileState,
  contextCompactRuntime,
  currentChatGroupRef,
  currentChatRef,
  ensureChatTmpDirectory,
  getLiveChat,
  isProcessing,
  liveChatRegistry,
  loadData,
  registerLiveInstance,
  updateChatContent,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';
import { createChatGenerationService } from '@/composables/chat/services/chat-generation-service';
import { createChatHistoryService } from '@/composables/chat/services/chat-history-service';
import { createChatImageService } from '@/composables/chat/services/chat-image-service';
import { createChatRegenerationService } from '@/composables/chat/services/chat-regeneration-service';
import { createChatTitleService } from '@/composables/chat/services/chat-title-service';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import { useChatUiServices } from './useChatUiServices';

export type ChatConversationActionsAdapter = {
  sendMessage({
    chatId,
    content,
    parentId,
    attachments,
    lmParameters,
  }: {
    chatId: string | undefined;
    content: string;
    parentId: string | null | undefined;
    attachments: Attachment[] | undefined;
    lmParameters: LmParameters | undefined;
  }): Promise<boolean>;

  regenerateMessage({
    chatId,
    failedMessageId,
  }: {
    chatId: string | undefined;
    failedMessageId: string;
  }): Promise<void>;

  abortChat({
    chatId,
  }: {
    chatId: string | undefined;
  }): void;

  editMessage({
    chatId,
    messageId,
    newContent,
    lmParameters,
  }: {
    chatId: string | undefined;
    messageId: string;
    newContent: string;
    lmParameters: LmParameters | undefined;
  }): Promise<void>;

  switchVersion({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): Promise<void>;

  forkChat({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): Promise<string | null>;

  getSiblings({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): MessageNode[];

  TEST_ONLY: Record<string, never>;
};

export function useChatConversationActions(): ChatConversationActionsAdapter {
  const { settings } = useSettings();
  const { addErrorEvent } = useGlobalEvents();
  const { enabledToolNames } = useChatTools();
  const { getNaidanSysfsMountSelection } = useChatWeshPreferences();
  const {
    availableModels,
    currentBridge,
    derivedState,
    hierarchyService,
    modelService,
    openService,
  } = useChatUiServices({});
  const imageGeneration = useImageGeneration();
  const titleService = createChatTitleService({
    getCurrentChatId: () => currentBridge.getCurrentChatId({}),
    getChatTarget: ({ chatId }) => currentBridge.getChatTargetByOptionalId({ chatId }),
    getLiveChat,
    registerLiveInstance,
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({
        chat,
        groups: derivedState.chatGroups.value,
        globalSettings: settings.value,
      });
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
    triggerCurrentChat: ({ chatId }) => currentBridge.triggerCurrentChat({ chatId }),
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
  const chatImageService = createChatImageService({
    getCurrentChat: () => currentBridge.getCurrentChat({}),
    getLiveChat: ({ chat }) => currentBridge.getChatTargetById({ id: chat.id }) ?? undefined,
    getAvailableModels: () => availableModels.value,
    getStorageType: () => settings.value.storageType,
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({
        chat,
        groups: derivedState.chatGroups.value,
        globalSettings: settings.value,
      });
      return {
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders ? [...resolved.endpointHttpHeaders] : undefined,
      };
    },
    performGeneration: imageGeneration.performBase64Generation,
    handleImageGenerationImpl: imageGeneration.handleImageGeneration,
    sendImageRequestImpl: imageGeneration.sendImageRequest,
    updateChatContent,
    triggerCurrentChat: ({ chatId }) => currentBridge.triggerCurrentChat({ chatId }),
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
    sendMessage: async (_args) => false,
  });
  const generationService = createChatGenerationService({
    getCurrentChat: () => currentBridge.getCurrentChat({}),
    getChatTarget: ({ chatId }) => currentBridge.getChatTargetByOptionalId({ chatId }),
    getLiveChat,
    registerLiveInstance,
    isProcessing,
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
    triggerCurrentChat: ({ chatId }) => currentBridge.triggerCurrentChat({ chatId }),
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({
        chat,
        groups: derivedState.chatGroups.value,
        globalSettings: settings.value,
      });
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
    fetchAvailableModels: ({ chatId }) => modelService.fetchAvailableModels({ chatId, customEndpoint: undefined }),
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
    isImageMode: imageGeneration.isImageMode,
    getSelectedImageModel: imageGeneration.getSelectedImageModel,
    getResolution: imageGeneration.getResolution,
    getCount: imageGeneration.getCount,
    getSteps: imageGeneration.getSteps,
    getSeed: imageGeneration.getSeed,
    getPersistAs: imageGeneration.getPersistAs,
    getAvailableModels: () => availableModels.value,
    reportMissingImageModel: async (_args) => {
      addErrorEvent({ source: 'useChat:sendMessage', message: 'No image generation model found (starting with x/z-image-turbo:).' });
    },
    setActiveGeneration: ({ chatId, generation }) => {
      chatRuntimeStore.setActiveGeneration({ chatId, generation });
    },
    deleteActiveGeneration: ({ chatId }) => {
      chatRuntimeStore.deleteActiveGeneration({ chatId });
    },
    hasActiveGeneration: ({ chatId }) => chatRuntimeStore.activeGenerations.has(chatId),
    handleImageGeneration: chatImageService.handleImageGeneration,
    loadBinaryObject: ({ id }) => storageService.getFile({ binaryObjectId: id }),
    persistToolContent: async ({ text, type, toolCallId }) => {
      const binaryThreshold = 100 * 1024;
      if (text.length > binaryThreshold) {
        const blob = new Blob([text], { type: 'text/plain' });
        const binaryId = crypto.randomUUID();
        await storageService.saveFile(blob, binaryId, `tool_${type}_${toolCallId}.txt`);
        return { type: 'binary_object' as const, id: binaryId };
      }
      return { type: 'text' as const, text };
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
        ? (currentChatGroupRef.value?.id === chat.groupId
          ? currentChatGroupRef.value.mounts
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
      useStoragePersistence().requestPersistence();
    },
    showGenerationFailedToast: async ({ chat }) => {
      if (currentChatRef.value && currentChatRef.value.id === chat.id) {
        return;
      }
      try {
        useToast().addToast({
          message: `Generation failed in "${chat.title || 'New Chat'}"`,
          actionLabel: 'View',
          onAction: async () => {
            await openService.openChat({ id: chat.id, leafId: undefined });
          },
        });
      } catch {
        // ignore
      }
    },
    generateChatTitle: ({ chatId, signal, titleModelIdOverride }) => titleService.generateChatTitle({
      chatId,
      signal,
      titleModelIdOverride,
    }),
    reorderSidebarChatAfterSend: ({ chatId }) => hierarchyService.reorderSidebarChatAfterSend({ chatId }),
  });
  const historyService = createChatHistoryService({
    currentChatRef,
    liveChatRegistry,
    getLiveChat,
    registerLiveInstance,
    updateChatContent,
    updateChatMeta,
    updateHierarchy: updater => storageService.updateHierarchy(updater),
    loadData,
    openChat: ({ id }) => openService.openChat({ id, leafId: undefined }),
    canPersistBinary: () => storageService.canPersistBinary,
    saveFile: ({ blob, binaryObjectId, originalName }) => storageService.saveFile(blob, binaryObjectId, originalName),
    isProcessing,
    abortChat,
    sendMessage: async ({ content, parentId, attachments, chatTarget, lmParameters }) => {
      await generationService.sendMessage({ content, parentId, attachments, chatTarget, lmParameters });
    },
    triggerCurrentChat: ({ chatId }) => currentBridge.triggerCurrentChat({ chatId }),
  });
  const regenerationService = createChatRegenerationService({
    getCurrentChat: () => currentBridge.getCurrentChat({}),
    getChatTarget: ({ chatId }) => currentBridge.getChatTargetByOptionalId({ chatId }),
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
    triggerCurrentChat: ({ chatId }) => currentBridge.triggerCurrentChat({ chatId }),
    generateResponse: generationService.generateResponse,
  });

  async function sendMessage({
    chatId,
    content,
    parentId,
    attachments,
    lmParameters,
  }: {
    chatId: string | undefined;
    content: string;
    parentId: string | null | undefined;
    attachments: Attachment[] | undefined;
    lmParameters: LmParameters | undefined;
  }): Promise<boolean> {
    if (chatId !== undefined) {
      return await generationService.sendMessageForChat({
        chatId,
        content,
        parentId,
        attachments,
        lmParameters,
      });
    }

    return await generationService.sendMessage({
      content,
      parentId,
      attachments,
      chatTarget: undefined,
      lmParameters,
    });
  }

  async function regenerateMessage({
    chatId,
    failedMessageId,
  }: {
    chatId: string | undefined;
    failedMessageId: string;
  }): Promise<void> {
    if (chatId !== undefined) {
      await regenerationService.regenerateMessageForChat({
        chatId,
        failedMessageId,
      });
      return;
    }

    await regenerationService.regenerateMessage({
      failedMessageId,
    });
  }

  function abortChat({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    const id = chatId ?? currentBridge.getCurrentChatId({}) ?? undefined;
    if (id === undefined) {
      return;
    }

    contextCompactRuntime.getActiveContextCompaction({ chatId: id })?.abort();
    if (chatRuntimeStore.activeGenerations.has(id)) {
      chatRuntimeStore.getActiveGeneration({ chatId: id })?.controller.abort();
      storageService.notify({ type: 'chat_content_generation', id, status: 'abort_request', timestamp: Date.now() });
    } else if (chatRuntimeStore.hasExternalGeneration({ chatId: id })) {
      storageService.notify({ type: 'chat_content_generation', id, status: 'abort_request', timestamp: Date.now() });
    }
    titleService.abortTitleGeneration({ chatId: id });
  }

  async function editMessage({
    chatId,
    messageId,
    newContent,
    lmParameters,
  }: {
    chatId: string | undefined;
    messageId: string;
    newContent: string;
    lmParameters: LmParameters | undefined;
  }): Promise<void> {
    if (chatId !== undefined) {
      await historyService.editMessageForChat({
        chatId,
        messageId,
        newContent,
        lmParameters,
      });
      return;
    }

    await historyService.editMessage({
      messageId,
      newContent,
      lmParameters,
    });
  }

  async function switchVersion({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): Promise<void> {
    if (chatId !== undefined) {
      await historyService.switchVersionForChat({
        chatId,
        messageId,
      });
      return;
    }

    await historyService.switchVersion({
      messageId,
    });
  }

  async function forkChat({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): Promise<string | null> {
    if (chatId !== undefined) {
      return await historyService.forkChatForChat({
        chatId,
        messageId,
      });
    }

    return await historyService.forkChat({
      messageId,
    });
  }

  function getSiblings({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): MessageNode[] {
    return historyService.getSiblings({
      messageId,
      chatId,
    });
  }

  return {
    sendMessage,
    regenerateMessage,
    abortChat,
    editMessage,
    switchVersion,
    forkChat,
    getSiblings,
    TEST_ONLY: {},
  };
}
