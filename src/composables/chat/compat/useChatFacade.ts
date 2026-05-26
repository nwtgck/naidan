import { triggerRef, type ComputedRef } from 'vue';
import type { Attachment, Chat, EndpointType, LmParameters, MessageNode, Reasoning, Settings } from '@/models/types';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import { storageService } from '@/services/storage';
import { transformersJsService } from '@/services/transformers-js';
import { useSettings } from '@/composables/useSettings';
import { useImageGeneration } from '@/composables/useImageGeneration';
import { useChatDisplayFlow } from '@/composables/useChatDisplayFlow';
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
import {
  generateImageForChat,
  handleImageGenerationForChat,
  sendImageRequestForChat as sendImageRequestForChatImpl,
} from '@/composables/chat/chat-scoped/chat-image-helpers';
import {
  generateResponseForAssistant,
  regenerateMessageForChat as regenerateMessageForScopedChat,
  regenerateMessageForCurrentChat,
  sendMessageForChat as sendMessageForScopedChat,
  sendMessageToCurrentChat,
  sendMessageToTargetChat,
} from '@/composables/chat/chat-scoped/chat-generation-flow';
import {
  commitFullHistoryManipulationForChat,
  editCurrentChatMessage,
  editMessageForChat as editMessageForScopedChat,
  forkChatForChat as forkScopedChat,
  forkCurrentChat,
  getSiblingsForChat,
  switchVersionForChat as switchVersionForScopedChat,
  switchVersionInCurrentChat,
} from '@/composables/chat/chat-scoped/chat-history-flow';
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
    imageModeMap,
    imageResolutionMap,
    imageCountMap,
    imagePersistAsMap,
    imageProgressMap,
    imageModelOverrideMap,
  } = useImageGeneration();

  async function handleImageGeneration({
    chatId,
    assistantId,
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs,
    images,
    model,
    signal,
  }: {
    chatId: string;
    assistantId: string;
    prompt: string;
    width: number;
    height: number;
    count: number;
    steps: number | undefined;
    seed: number | 'browser_random' | undefined;
    persistAs: import('@/utils/image-generation').ImageRequestParams['persistAs'] | undefined;
    images: { blob: Blob }[];
    model: string | undefined;
    signal: AbortSignal | undefined;
  }) {
    const chat = chatCurrentBridge.getChatTargetById({ id: chatId });
    if (chat === null) {
      return;
    }

    const resolved = resolveChatSettings({ chat, groups: chatGroups.value, globalSettings: settings.value });
    if (resolved.endpointUrl === undefined) {
      throw new Error('Image generation requires an endpoint URL');
    }

    await handleImageGenerationForChat({
      chatId,
      assistantId,
      prompt,
      width,
      height,
      count,
      steps,
      seed,
      persistAs,
      images,
      model,
      availableModels: availableModels.value,
      endpointUrl: resolved.endpointUrl,
      endpointHttpHeaders: resolved.endpointHttpHeaders ? [...resolved.endpointHttpHeaders] : undefined,
      storageType: settings.value.storageType,
      signal,
      getLiveChat,
      updateChatContent: async ({ chatId, updater }) => {
        await updateChatContent({
          id: chatId,
          updater: (current) => {
            if (current === null) {
              throw new Error('Chat content not found');
            }
            return updater(current);
          },
        });
      },
      triggerChatRef: ({ chatId }) => chatCurrentBridge.triggerCurrentChat({ chatId }),
      incTask: ({ chatId, type }) => {
        if (type === 'process') {
          chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
        }
      },
      decTask: ({ chatId, type }) => {
        if (type === 'process') {
          chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
        }
      },
    });
  }

  async function sendImageRequestForChatCompat({
    chatId,
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs,
    attachments,
  }: {
    chatId: string;
    prompt: string;
    width: number;
    height: number;
    count: number;
    steps: number | undefined;
    seed: number | 'browser_random' | undefined;
    persistAs: import('@/utils/image-generation').ImageRequestParams['persistAs'];
    attachments: Attachment[];
  }) {
    return await sendImageRequestForChatImpl({
      chatId,
      prompt,
      width,
      height,
      count,
      steps,
      seed,
      persistAs,
      attachments,
      availableModels: availableModels.value,
      sendMessage: ({ content, parentId, attachments }) => {
        return sendMessageForChat({
          chatId,
          content,
          parentId,
          attachments,
          lmParameters: undefined,
        });
      },
    });
  }
  const sendImageRequestForChat = sendImageRequestForChatCompat;
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
  async function generateResponse({
    chat,
    assistantId,
    lmParameters,
    onReady,
  }: {
    chat: Chat | Readonly<Chat>;
    assistantId: string;
    lmParameters?: LmParameters;
    onReady?: (_args: Record<never, never>) => void;
  }): Promise<void> {
    await generateResponseForAssistant({
      chat,
      assistantId,
      lmParameters,
      onReady,
    });
  }

  async function sendMessage({
    content,
    parentId,
    attachments,
    chatTarget,
    lmParameters,
  }: {
    content: string;
    parentId?: string | null;
    attachments?: Attachment[];
    chatTarget?: Chat | Readonly<Chat>;
    lmParameters?: LmParameters;
  }): Promise<boolean> {
    if (chatTarget !== undefined) {
      return await sendMessageToTargetChat({
        targetChat: chatTarget,
        content,
        parentId,
        attachments,
        lmParameters,
      });
    }

    return await sendMessageToCurrentChat({
      content,
      parentId,
      attachments,
      lmParameters,
    });
  }

  async function sendMessageForChat({
    chatId,
    content,
    parentId,
    attachments,
    lmParameters,
  }: {
    chatId: string;
    content: string;
    parentId: string | null | undefined;
    attachments: Attachment[] | undefined;
    lmParameters: LmParameters | undefined;
  }): Promise<boolean> {
    return await sendMessageForScopedChat({
      chatId,
      content,
      parentId,
      attachments,
      lmParameters,
    });
  }

  function abortContextCompact({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    const targetChatId = chatId ?? chatCurrentBridge.getCurrentChatId({}) ?? undefined;
    abortContextCompactForChat({ chatId: targetChatId });
  }

  function abortChat({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    const targetChatId = chatId ?? chatCurrentBridge.getCurrentChatId({}) ?? undefined;
    if (targetChatId === undefined) {
      return;
    }

    abortContextCompact({
      chatId: targetChatId,
    });

    if (chatRuntimeStore.activeGenerations.has(targetChatId)) {
      chatRuntimeStore.getActiveGeneration({ chatId: targetChatId })?.controller.abort();
      storageService.notify({
        type: 'chat_content_generation',
        id: targetChatId,
        status: 'abort_request',
        timestamp: Date.now(),
      });
    } else if (chatRuntimeStore.hasExternalGeneration({ chatId: targetChatId })) {
      storageService.notify({
        type: 'chat_content_generation',
        id: targetChatId,
        status: 'abort_request',
        timestamp: Date.now(),
      });
    }

    abortTitleGeneration({
      chatId: targetChatId,
    });
  }

  async function compactCurrentBranch({
    keepRecentMessages,
    instructionOverride,
  }: {
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }) {
    const currentChatId = chatCurrentBridge.getCurrentChatId({}) ?? undefined;
    if (currentChatId === undefined) {
      return false;
    }

    const result = await runCompactCurrentBranchForChat({
      chatId: currentChatId,
      keepRecentMessages,
      instructionOverride,
    });
    return result.status === 'compacted';
  }

  async function forkChat({
    messageId,
    chatId,
  }: {
    messageId: string;
    chatId?: string;
  }): Promise<string | null> {
    if (chatId !== undefined) {
      return await forkScopedChat({
        chatId,
        messageId,
      });
    }

    return await forkCurrentChat({
      messageId,
    });
  }

  async function forkChatForChat({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }): Promise<string | null> {
    return await forkScopedChat({
      chatId,
      messageId,
    });
  }

  async function editMessage({
    messageId,
    newContent,
    lmParameters,
  }: {
    messageId: string;
    newContent: string;
    lmParameters?: LmParameters;
  }): Promise<void> {
    await editCurrentChatMessage({
      messageId,
      newContent,
      lmParameters,
    });
  }

  async function editMessageForChat({
    chatId,
    messageId,
    newContent,
    lmParameters,
  }: {
    chatId: string;
    messageId: string;
    newContent: string;
    lmParameters?: LmParameters;
  }): Promise<void> {
    await editMessageForScopedChat({
      chatId,
      messageId,
      newContent,
      lmParameters,
    });
  }

  async function switchVersion({
    messageId,
  }: {
    messageId: string;
  }): Promise<void> {
    await switchVersionInCurrentChat({
      messageId,
    });
  }

  async function switchVersionForChat({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }): Promise<void> {
    await switchVersionForScopedChat({
      chatId,
      messageId,
    });
  }

  function getSiblings({
    messageId,
    chatId,
  }: {
    messageId: string;
    chatId?: string;
  }): MessageNode[] {
    return getSiblingsForChat({
      chatId,
      messageId,
    });
  }

  async function regenerateMessage({
    failedMessageId,
  }: {
    failedMessageId: string;
  }): Promise<void> {
    await regenerateMessageForCurrentChat({
      failedMessageId,
    });
  }

  async function regenerateMessageForChat({
    chatId,
    failedMessageId,
  }: {
    chatId: string;
    failedMessageId: string;
  }): Promise<void> {
    await regenerateMessageForScopedChat({
      chatId,
      failedMessageId,
    });
  }

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
  const commitFullHistoryManipulation = commitFullHistoryManipulationForChat;
  async function generateImage({
    prompt,
    model,
    width,
    height,
    steps,
    seed,
    images,
    chat,
    signal,
  }: {
    prompt: string;
    model: string;
    width: number;
    height: number;
    steps: number | undefined;
    seed: number | undefined;
    images: { blob: Blob }[];
    chat: Chat;
    signal: AbortSignal | undefined;
  }) {
    return await generateImageForChat({
      prompt,
      model,
      width,
      height,
      steps,
      seed,
      images,
      chat,
      chatGroups: chatGroups.value,
      settings: settings.value as Settings,
      signal,
    });
  }

  async function sendImageRequest({
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs,
    attachments,
  }: {
    prompt: string;
    width: number;
    height: number;
    count: number;
    steps: number | undefined;
    seed: number | 'browser_random' | undefined;
    persistAs: import('@/utils/image-generation').ImageRequestParams['persistAs'];
    attachments: Attachment[];
  }) {
    const currentChatId = chatCurrentBridge.getCurrentChatId({}) ?? undefined;
    if (currentChatId === undefined) {
      return false;
    }

    return await sendImageRequestForChatCompat({
      chatId: currentChatId,
      prompt,
      width,
      height,
      count,
      steps,
      seed,
      persistAs,
      attachments,
    });
  }

  const createChatGroup = chatOrganization.createChatGroup;
  const deleteChatGroup = chatOrganization.deleteChatGroup;
  const duplicateChatGroup = chatOrganization.duplicateChatGroup;
  const renameChatGroup = chatOrganization.renameChatGroup;
  const updateChatGroupMetadata = chatOrganization.updateChatGroupMetadata;
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
