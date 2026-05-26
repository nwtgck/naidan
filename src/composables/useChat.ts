import { generateId } from '@/utils/id';
import { ref, computed, reactive, triggerRef, readonly, toRaw, type ComputedRef } from 'vue';
import type { Chat, AssistantMessageNode, ChatGroup, SidebarItem, ChatSummary, Settings } from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import { storageService } from '@/services/storage';
import { transformersJsService } from '@/services/transformers-js';
import { useSettings } from './useSettings';
import { useConfirm } from './useConfirm';
import { useGlobalEvents } from './useGlobalEvents';
import { useStoragePersistence } from './useStoragePersistence';
import { useImageGeneration } from './useImageGeneration';
import { useToast } from './useToast';
import { findNodeInBranch, findParentInBranch, getChatBranchIterator, getAllMessages } from '@/utils/chat-tree';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';

import { useChatTools } from './useChatTools';
import { useChatWeshPreferences } from './useChatWeshPreferences';
import { getEnabledTools } from '@/services/tools/factory';
import { useChatDisplayFlow } from './useChatDisplayFlow';
import { createChatDataStore } from './chat/chat-data-store';
import { createChatRuntimeStore } from './chat/chat-runtime-store';
import { createContextCompactRuntime } from './chat/context-compact-runtime';
import { createContextCompactService } from './chat/context-compact-service';
import { createChatGenerationService } from './chat/chat-generation-service';
import { createChatHierarchyService } from './chat/chat-hierarchy-service';
import { createChatHistoryService } from './chat/chat-history-service';
import { createChatImageService } from './chat/chat-image-service';
import { createChatLifecycleService } from './chat/chat-lifecycle-service';
import { createChatMountService } from './chat/chat-mount-service';
import { createChatMetadataService } from './chat/chat-metadata-service';
import { createChatModelService } from './chat/chat-model-service';
import { createChatOpenService } from './chat/chat-open-service';
import { createChatTitleService } from './chat/chat-title-service';
import { getOPFSTmpManager } from '@/services/opfs-tmp-manager';
import { shouldIncludeWritableTmpMount } from '@/services/wesh/mount-policy';
import {
  type ContextCompactProgress,
} from '@/services/context-compact';

export type { AddToastOptions } from './chat/chat-lifecycle-service';

const volatileAssistantErrors = reactive(new Map<string, Map<string, string>>());
const volatileToolOutputs = reactive(new Map<string, string>());
const chatTmpDirectories = reactive(new Map<string, {
  handle: FileSystemDirectoryHandle;
  mountPath: '/tmp';
}>());
const chatRuntimeStore = createChatRuntimeStore({});
const contextCompactRuntime = createContextCompactRuntime({});

const streaming = computed(() => chatRuntimeStore.activeGenerations.size > 0 || chatRuntimeStore.externalGenerations.size > 0);
const isGeneratingTitle = ({ chatId }: { chatId: string }) => chatRuntimeStore.isGeneratingTitle({ chatId });
const generatingTitle = computed(() => {
  if (!_currentChat.value) return false;
  return isGeneratingTitle({ chatId: toRaw(_currentChat.value).id });
});
const contextCompactProgress = computed<ContextCompactProgress>(() => {
  return getContextCompactProgress({ chatId: _currentChat.value ? toRaw(_currentChat.value).id : undefined });
});
const fetchingModels = computed(() => {
  if (chatRuntimeStore.getTaskCount({ key: { kind: 'fetch', chatId: undefined } }) > 0) return true;
  if (!_currentChat.value) return false;
  return chatRuntimeStore.getTaskCount({
    key: {
      kind: 'fetch',
      chatId: toRaw(_currentChat.value).id,
    },
  }) > 0;
});

const creatingChat = ref(false);
const availableModels = ref<string[]>([]);


// --- Lifecycle & Cleanup ---

if ((() => {
  const t = typeof window;
  switch (t) {
  case 'undefined': return false;
  case 'object':
  case 'boolean':
  case 'string':
  case 'number':
  case 'function':
  case 'symbol':
  case 'bigint':
    return true;
  default: {
    const _ex: never = t;
    return _ex;
  }
  }
})()) {
  window.addEventListener('beforeunload', () => {
    for (const item of chatRuntimeStore.activeGenerations.values()) {
      item.controller.abort();
    }
  });
}

function isTaskRunning({ chatId }: { chatId: string }) {
  return chatRuntimeStore.isTaskRunning({ chatId });
}

function isProcessing({ chatId }: { chatId: string }) {
  return chatRuntimeStore.isProcessing({ chatId });
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

function getContextCompactProgress({
  chatId,
}: {
  chatId: string | undefined;
}): ContextCompactProgress {
  return contextCompactRuntime.getProgress({ chatId });
}

function setVolatileAssistantError({ chatId, messageId, error }: {
  chatId: string;
  messageId: string;
  error: string;
}) {
  const existing = volatileAssistantErrors.get(chatId);
  if (existing) {
    existing.set(messageId, error);
    return;
  }

  volatileAssistantErrors.set(chatId, new Map([[messageId, error]]));
}

function clearVolatileAssistantError({ chatId, messageId }: {
  chatId: string;
  messageId: string;
}) {
  const existing = volatileAssistantErrors.get(chatId);
  if (!existing) return;

  existing.delete(messageId);
  if (existing.size === 0) {
    volatileAssistantErrors.delete(chatId);
  }
}

function applyVolatileAssistantErrorsToChat({ chat }: { chat: Chat }) {
  const errors = volatileAssistantErrors.get(chat.id);
  if (!errors || errors.size === 0) return;

  for (const [messageId, error] of errors.entries()) {
    const node = findNodeInBranch({ items: chat.root.items, targetId: messageId });
    if (!node || node.role !== 'assistant') continue;
    node.error = error;
  }
}


async function ensureChatTmpDirectory({
  chatId,
}: {
  chatId: string;
}): Promise<{
  handle: FileSystemDirectoryHandle;
  mountPath: '/tmp';
}> {
  const existing = chatTmpDirectories.get(chatId);
  if (existing) {
    return existing;
  }

  const created = {
    handle: await getOPFSTmpManager().createTmpDirectory({ prefix: chatId }),
    mountPath: '/tmp' as const,
  };
  chatTmpDirectories.set(chatId, created);
  return created;
}

function getChatTmpDirectory({
  chatId,
}: {
  chatId: string;
}): {
  handle: FileSystemDirectoryHandle;
  mountPath: '/tmp';
} | undefined {
  return chatTmpDirectories.get(chatId);
}

const chatDataStore = createChatDataStore({
  applyVolatileAssistantErrorsToChat,
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
  onMigration: (_args) => {
    for (const item of chatRuntimeStore.activeGenerations.values()) item.controller.abort();
    chatRuntimeStore.clearActiveGenerations({});
    chatRuntimeStore.clearActiveTaskCounts({});
    chatTmpDirectories.clear();
  },
});
const rootItems = chatDataStore.rootItems;
const _currentChat = chatDataStore.currentChatRef;
const _currentChatGroup = chatDataStore.currentChatGroupRef;
const liveChatRegistry = chatDataStore.liveChatRegistry;
const registerLiveInstance = chatDataStore.registerLiveInstance;
const unregisterLiveInstance = chatDataStore.unregisterLiveInstance;
const getLiveChat = chatDataStore.getLiveChat;
const loadData = chatDataStore.loadData;
const updateChatContent = chatDataStore.updateChatContent;
const updateChatMeta = chatDataStore.updateChatMeta;

transformersJsService.subscribeModelList(async () => {
  const { fetchAvailableModels, currentChat, resolvedSettings } = useChat();
  const type = resolvedSettings.value?.endpointType;
  if (type) {
    switch (type) {
    case 'transformers_js':
      await fetchAvailableModels({ chatId: currentChat.value?.id, customEndpoint: undefined });
      break;
    case 'openai':
    case 'ollama':
      break;
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled endpoint type: ${_ex}`);
    }
    }
  }
});

// Facade for broad existing callers. Prefer adding new state and feature logic to
// dedicated chat stores/services instead of growing this module further.
export function useChat() {
  const { settings } = useSettings();
  const { getNaidanSysfsMountSelection } = useChatWeshPreferences();

  const currentChat = computed(() => _currentChat.value ? readonly(_currentChat.value) : null);
  const currentChatGroup = computed(() => _currentChatGroup.value ? readonly(_currentChatGroup.value) : null);
  const sidebarItems = computed(() => rootItems.value);

  const chats = computed(() => {
    const all: ChatSummary[] = [];
    const collect = ({ items }: { items: SidebarItem[] }) => {
      items.forEach(item => {
        switch (item.type) {
        case 'chat':
          all.push(item.chat);
          break;
        case 'chat_group':
          collect({ items: item.chatGroup.items });
          break;
        default: {
          const _ex: never = item;
          return _ex;
        }
        }
      });
    };
    collect({ items: rootItems.value });
    return all;
  });

  const chatGroups = computed(() => {
    const all: ChatGroup[] = [];
    rootItems.value.forEach(item => {
      switch (item.type) {
      case 'chat_group':
        all.push(item.chatGroup);
        break;
      case 'chat':
        break;
      default: {
        const _ex: never = item;
        return _ex;
      }
      }
    });
    return all;
  });

  const resolvedSettings = computed(() => {
    if (!_currentChat.value) return null;
    return resolveChatSettings({ chat: toRaw(_currentChat.value), groups: chatGroups.value, globalSettings: settings.value });
  });

  const inheritedSettings = computed(() => {
    if (!_currentChat.value) return null;
    const chat = toRaw(_currentChat.value);
    const virtualChat: Chat = { ...chat, modelId: undefined, endpointType: undefined, endpointUrl: undefined, endpointHttpHeaders: undefined, systemPrompt: undefined, lmParameters: undefined, };
    return resolveChatSettings({ chat: virtualChat, groups: chatGroups.value, globalSettings: settings.value });
  });

  const activeMessages = computed(() => {
    if (!_currentChat.value) return [];
    return Array.from(getChatBranchIterator({ chat: _currentChat.value }));
  });

  const allMessages = computed(() => {
    if (!_currentChat.value) return [];
    return getAllMessages({ chat: _currentChat.value });
  });

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

  function hasMountsForChat({ chat }: { chat: Pick<Chat, 'mounts' | 'groupId'> }): boolean {
    if (settings.value.mounts && settings.value.mounts.length > 0) return true;
    if (chat.mounts && chat.mounts.length > 0) return true;
    if (chat.groupId) {
      const group = chatGroups.value.find(g => g.id === chat.groupId);
      if (group?.mounts && group.mounts.length > 0) return true;
    }
    return false;
  }

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
    creatingChat,
    currentChatRef: _currentChat,
    currentChatGroupRef: _currentChatGroup,
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
      chatTmpDirectories.clear();
    },
    deleteLiveChat: ({ chatId }) => {
      liveChatRegistry.delete(chatId);
    },
    deleteChatTmpDirectory: ({ chatId }) => {
      chatTmpDirectories.delete(chatId);
    },
  });
  const createNewChat = chatLifecycleService.createNewChat;
  const deleteChat = chatLifecycleService.deleteChat;
  const deleteAllChats = chatLifecycleService.deleteAllChats;

  const chatMetadataService = createChatMetadataService({
    getChatTarget: ({ id }) => {
      const liveChat = liveChatRegistry.get(id);
      if (liveChat) return liveChat;
      if (_currentChat.value && toRaw(_currentChat.value).id === id) {
        return _currentChat.value;
      }
      return null;
    },
    getCurrentChat: () => (_currentChat.value ? getLiveChat({ chat: _currentChat.value }) : null),
    triggerCurrentChat: ({ chatId }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
        triggerRef(_currentChat);
      }
    },
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
    availableModelsRef: availableModels,
    getChatGroups: () => chatGroups.value,
    getSettings: () => settings.value,
    triggerCurrentChat: ({ chatId }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
        triggerRef(_currentChat);
      }
    },
    runtimeStore: chatRuntimeStore,
    addErrorEvent,
  });
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
    imageModelOverrideMap
  } = useImageGeneration();

  const chatImageService = createChatImageService({
    getCurrentChat: () => (_currentChat.value ? getLiveChat({ chat: _currentChat.value }) : null),
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
    triggerCurrentChat: ({ chatId }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
        triggerRef(_currentChat);
      }
    },
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
    sendMessage: ({ content, parentId, attachments }) => sendMessage({ content, parentId, attachments }),
  });
  const handleImageGeneration = chatImageService.handleImageGeneration;
  const chatTitleService = createChatTitleService({
    getCurrentChatId: () => (_currentChat.value ? toRaw(_currentChat.value).id : null),
    getChatTarget: ({ chatId }) => (chatId ? liveChatRegistry.get(chatId) || null : _currentChat.value),
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
    triggerCurrentChat: ({ chatId }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
        triggerRef(_currentChat);
      }
    },
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
    getLiveChat,
    registerLiveInstance,
    isProcessing,
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
    triggerCurrentChat: ({ chatId }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
        triggerRef(_currentChat);
      }
    },
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
      const { useGlobalEvents } = await import('../composables/useGlobalEvents');
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
    setVolatileAssistantError,
    clearVolatileAssistantError,
    setVolatileToolOutput: ({ toolCallId, output }) => {
      volatileToolOutputs.set(toolCallId, output);
    },
    appendVolatileToolOutput: ({ toolCallId, text }) => {
      const previous = volatileToolOutputs.get(toolCallId) || '';
      volatileToolOutputs.set(toolCallId, previous + text);
    },
    deleteVolatileToolOutput: ({ toolCallId }) => {
      volatileToolOutputs.delete(toolCallId);
    },
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
        const { useToast } = await import('./useToast');
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

  const regenerateMessage = async ({ failedMessageId }: { failedMessageId: string }) => {
    if (!_currentChat.value) return;
    const chatId = toRaw(_currentChat.value).id;
    if (isProcessing({ chatId })) {
      abortChat({ chatId });
      // Wait for the task to actually stop and decTask to be called
      while (isProcessing({ chatId })) {
        await new Promise(r => setTimeout(r, 10));
      }
    }

    const chat = getLiveChat({ chat: _currentChat.value });
    chatRuntimeStore.startTask({
      key: {
        kind: 'process',
        chatId: chat.id,
      },
    });
    registerLiveInstance({ chat });
    try {
      const failedNode = findNodeInBranch({ items: chat.root.items, targetId: failedMessageId });
      if (!failedNode || failedNode.role !== 'assistant') return;
      const parent = findParentInBranch({ items: chat.root.items, childId: failedMessageId });
      if (!parent || parent.role !== 'user') return;
      const newAssistantMsg: AssistantMessageNode = {
        id: generateId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        modelId: failedNode.modelId,
        replies: { items: [] },
        attachments: undefined,
        thinking: undefined,
        error: undefined,
        lmParameters: failedNode.lmParameters || EMPTY_LM_PARAMETERS,
        toolCalls: undefined,
        results: undefined,
      };
      parent.replies.items.push(newAssistantMsg);
      chat.currentLeafId = newAssistantMsg.id;
      if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) triggerRef(_currentChat);
      await updateChatContent({ id: chat.id, updater: (current) => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }) });
      await updateChatMeta({ id: chat.id, updater: (curr) => {
        if (!curr) return chat;
        return { ...curr, updatedAt: Date.now(), currentLeafId: chat.currentLeafId };
      } });
      let markGenerationReady: (() => void) | undefined;
      const generationReady = new Promise<void>(resolve => {
        markGenerationReady = resolve;
      });
      generateResponse({
        chat,
        assistantId: newAssistantMsg.id,
        lmParameters: failedNode.lmParameters,
        onReady: (_args) => {
          markGenerationReady?.();
          markGenerationReady = undefined;
        },
      }).catch(e => {
        markGenerationReady?.();
        markGenerationReady = undefined;
        console.error('Background generation failed:', e);
      });
      await generationReady;
    } finally {
      chatRuntimeStore.finishTask({
        key: {
          kind: 'process',
          chatId: chat.id,
        },
      });
    }
  };

  const abortChat = ({ chatId }: { chatId: string | undefined }) => {
    const id = chatId || (_currentChat.value ? toRaw(_currentChat.value).id : null);
    if (id) {
      abortContextCompact({ chatId: id });
      if (chatRuntimeStore.activeGenerations.has(id)) {
        chatRuntimeStore.getActiveGeneration({ chatId: id })?.controller.abort();
        storageService.notify({ type: 'chat_content_generation', id, status: 'abort_request', timestamp: Date.now() });
      } else if (chatRuntimeStore.hasExternalGeneration({ chatId: id })) {
        storageService.notify({ type: 'chat_content_generation', id, status: 'abort_request', timestamp: Date.now() });
      }
      // Also abort title generation for this chat
      abortTitleGeneration({ chatId: id });
    }
  };
  const contextCompactService = createContextCompactService({
    getCurrentChat: () => (_currentChat.value ? getLiveChat({ chat: _currentChat.value }) : null),
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
    triggerCurrentChat: ({ chatId }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
        triggerRef(_currentChat);
      }
    },
    addErrorEvent,
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
  });
  const abortContextCompact = contextCompactService.abortContextCompact;
  const compactCurrentBranch = async ({
    keepRecentMessages,
    instructionOverride,
  }: {
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }): Promise<boolean> => {
    const result = await contextCompactService.compactCurrentBranch({
      keepRecentMessages,
      instructionOverride,
    });
    return result.status === 'compacted';
  };

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
    triggerCurrentChat: ({ chatId }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
        triggerRef(_currentChat);
      }
    },
  });
  const forkChat = chatHistoryService.forkChat;
  const editMessage = chatHistoryService.editMessage;
  const switchVersion = chatHistoryService.switchVersion;
  const getSiblings = chatHistoryService.getSiblings;

  const toggleDebug = chatMetadataService.toggleDebug;

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

  const __testOnlySetCurrentChat = ({ chat }: { chat: Chat | null }) => {
    _currentChat.value = chat;
    if (chat) registerLiveInstance({ chat });
  };
  const __testOnlySetCurrentChatGroup = ({ group }: { group: ChatGroup | null }) => {
    _currentChatGroup.value = group;
  };
  const __testOnlySetContextCompactProgress = ({
    chatId,
    progress,
  }: {
    chatId: string;
    progress: ContextCompactProgress;
  }) => {
    setContextCompactProgress({
      chatId,
      progress,
    });
  };
  const clearLiveChatRegistry = (_params: Record<string, never>) => {
    liveChatRegistry.clear();
  };

  const clearActiveTaskCounts = (_params: Record<string, never>) => {
    chatRuntimeStore.clearActiveTaskCounts({});
  };

  const getVolatileToolOutput = ({ toolCallId }: { toolCallId: string }) => {
    return volatileToolOutputs.get(toolCallId);
  };

  const {
    chatFlow,
    isThinkingActive,
    isWaitingResponse
  } = useChatDisplayFlow({
    chat: currentChat as unknown as ComputedRef<Chat | null>,
    isProcessing
  });

  return {
    rootItems, chats, chatGroups, sidebarItems, currentChat, currentChatGroup, resolvedSettings, inheritedSettings, activeMessages, allMessages, streaming, generatingTitle, availableModels, fetchingModels,
    imageModeMap, imageResolutionMap, imageCountMap, imagePersistAsMap, imageProgressMap, imageModelOverrideMap,
    isImageMode, toggleImageMode, getResolution, updateResolution, getCount, updateCount, getSteps, updateSteps, getSeed, updateSeed, getPersistAs, updatePersistAs, setImageModel, getSelectedImageModel, getSortedImageModels, getReasoningEffort, updateReasoningEffort,
    loadChats: loadData, fetchAvailableModels, createNewChat, openChat, openChatAtMessage, openChatGroup, deleteChat, deleteAllChats, renameChat, updateChatModel, updateChatGroupOverride, updateChatSettings, generateChatTitle, sendMessage, regenerateMessage, forkChat, editMessage, switchVersion, getSiblings, toggleDebug, commitFullHistoryManipulation, generateImage, generateResponse, handleImageGeneration, sendImageRequest, createChatGroup, deleteChatGroup, duplicateChatGroup, setChatGroupCollapsed, renameChatGroup, updateChatGroupMetadata, persistSidebarStructure, abortChat, abortTitleGeneration, updateChatMeta, updateChatContent, moveChatToGroup, addMountToChat, removeMountFromChat, updateChatMount, addMountToChatGroup, removeMountFromChatGroup, updateChatGroupMount, compactCurrentBranch, abortContextCompact, getContextCompactProgress,
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
      volatileToolOutputs,
      __testOnlySetCurrentChat,
      __testOnlySetCurrentChatGroup,
      __testOnlySetContextCompactProgress,
    }
  };
}
