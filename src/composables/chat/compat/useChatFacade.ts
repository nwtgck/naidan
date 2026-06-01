import { computed, type ComputedRef } from 'vue';
import type { Attachment, Chat, EndpointType, LmParameters, MessageNode, Reasoning, Settings } from '@/models/types';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
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
import { createChatTestSupport } from '@/composables/chat/chat-test-support';
import {
  updateChatGroupOverrideById,
} from '@/composables/chat/chat-scoped/chat-metadata-helpers';
import {
  generateImageForChat,
  handleImageGenerationForChat,
  sendImageRequestForChat as sendImageRequestForChatImpl,
} from '@/composables/chat/chat-scoped/chat-image-helpers';
import { useChatMetadata } from '@/composables/chat/useChatMetadata';
import { useChatModels } from '@/composables/chat/useChatModels';
import { useChatTitle as useOwnedChatTitle } from '@/composables/chat/useChatTitle';
import {
  generateResponseForAssistant,
  sendMessageToTargetChat,
} from '@/composables/chat/chat-scoped/chat-generation-flow';
import {
  commitFullHistoryManipulationForChat,
  getSiblingsForChat,
} from '@/composables/chat/chat-scoped/chat-history-flow';
import { useChatCompact } from '@/composables/chat/chat-scoped/useChatCompact';
import { useChatGeneration } from '@/composables/chat/chat-scoped/useChatGeneration';
import { useChatGroupMounts } from '@/composables/chat/chat-scoped/useChatGroupMounts';
import { useChatHistory } from '@/composables/chat/chat-scoped/useChatHistory';
import { useChatImageGeneration } from '@/composables/chat/chat-scoped/useChatImageGeneration';
import { useChatMounts } from '@/composables/chat/chat-scoped/useChatMounts';
import type { AddToastOptions } from '@/composables/chat/ui/useChatLifecycle';
import { useChatLifecycle } from '@/composables/chat/ui/useChatLifecycle';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import { useChatOrganization } from '@/composables/chat/ui/useChatOrganization';
import { useSidebarStructure } from '@/composables/chat/ui/useSidebarStructure';

export type { AddToastOptions } from '@/composables/chat/ui/useChatLifecycle';

// Compatibility facade for broad legacy tests and legacy callers.
// Production feature logic should live in scoped composables and helpers.
// Only add behavior here when it is required to preserve the legacy useChat API.
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
  const chatMetadata = useChatMetadata({});
  const chatModelsOwner = useChatModels({});
  const chatTitleOwner = useOwnedChatTitle({});
  const sidebarItems = chatDerivedState.sidebarItems;
  const chats = chatDerivedState.chats;
  const chatGroups = chatDerivedState.chatGroups;
  const resolvedSettings = chatDerivedState.resolvedSettings;
  const inheritedSettings = chatDerivedState.inheritedSettings;
  const activeMessages = chatDerivedState.activeMessages;
  const allMessages = chatDerivedState.allMessages;

  function createScopedChatId({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    return computed(() => chatId);
  }

  function createScopedChatGroupId({
    chatGroupId,
  }: {
    chatGroupId: string | undefined;
  }) {
    return computed(() => chatGroupId);
  }

  function getCurrentChatGeneration() {
    return useChatGeneration({
      chatId: computed(() => _currentChat.value?.id),
    });
  }

  function getCurrentChatHistory() {
    return useChatHistory({
      chatId: computed(() => _currentChat.value?.id),
    });
  }

  function getCurrentChatCompact() {
    return useChatCompact({
      chatId: computed(() => _currentChat.value?.id),
    });
  }

  function getCurrentChatImageGeneration() {
    return useChatImageGeneration({
      chatId: computed(() => _currentChat.value?.id),
    });
  }

  async function addMountToChat({
    chatId,
    mount,
  }: {
    chatId: string;
    mount: import('@/models/types').Mount;
  }) {
    const chatMounts = useChatMounts({
      chatId: createScopedChatId({ chatId }),
    });
    await chatMounts.addMount({ mount });
  }

  async function removeMountFromChat({
    chatId,
    volumeId,
  }: {
    chatId: string;
    volumeId: string;
  }) {
    const chatMounts = useChatMounts({
      chatId: createScopedChatId({ chatId }),
    });
    await chatMounts.removeMount({ volumeId });
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
    const chatMounts = useChatMounts({
      chatId: createScopedChatId({ chatId }),
    });
    await chatMounts.updateMount({
      volumeId,
      readOnly,
    });
  }

  async function addMountToChatGroup({
    groupId,
    mount,
  }: {
    groupId: string;
    mount: import('@/models/types').Mount;
  }) {
    const chatGroupMounts = useChatGroupMounts({
      chatGroupId: createScopedChatGroupId({ chatGroupId: groupId }),
    });
    await chatGroupMounts.addMount({ mount });
  }

  async function removeMountFromChatGroup({
    groupId,
    volumeId,
  }: {
    groupId: string;
    volumeId: string;
  }) {
    const chatGroupMounts = useChatGroupMounts({
      chatGroupId: createScopedChatGroupId({ chatGroupId: groupId }),
    });
    await chatGroupMounts.removeMount({ volumeId });
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
    const chatGroupMounts = useChatGroupMounts({
      chatGroupId: createScopedChatGroupId({ chatGroupId: groupId }),
    });
    await chatGroupMounts.updateMount({
      volumeId,
      mountPath,
      readOnly,
    });
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
    await chatMetadata.rename({
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
    await chatMetadata.updateModel({
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
    await chatMetadata.updateSettings({
      chatId: id,
      updates,
    });
  }

  function getReasoningEffort({
    chatId,
  }: {
    chatId: string;
  }) {
    return chatMetadata.reasoningEffort({
      chatId: computed(() => chatId),
    }).value;
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
      return await chatModelsOwner.fetchForEndpoint({
        customEndpoint: {
          type: customEndpoint.type,
          url: customEndpoint.url,
          headers: customEndpoint.headers ? customEndpoint.headers.map(([name, value]) => [name, value]) : undefined,
        },
      });
    }

    if (chatId === undefined) {
      return await chatModelsOwner.fetchForGlobalEndpoint({});
    }

    return await chatModelsOwner.fetchForChat({
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

    if (signal !== undefined) {
      return await chatTitleOwner.generateTitle({
        chatId,
        signal,
        titleModelIdOverride,
      });
    }

    return await chatTitleOwner.generateTitle({
      chatId,
      signal: undefined,
      titleModelIdOverride,
    });
  }

  function abortTitleGeneration({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId !== undefined) {
      chatTitleOwner.abortTitleGeneration({
        chatId,
      });
      return;
    }

    const currentChatId = chatCurrentBridge.getCurrentChatId({});
    if (currentChatId === null) {
      return;
    }
    chatTitleOwner.abortTitleGeneration({
      chatId: currentChatId,
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

    return await getCurrentChatGeneration().sendMessage({
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
    const chatGeneration = useChatGeneration({
      chatId: createScopedChatId({ chatId }),
    });
    return await chatGeneration.sendMessage({
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
    if (chatId !== undefined) {
      const chatCompact = useChatCompact({
        chatId: createScopedChatId({ chatId }),
      });
      chatCompact.abort({});
      return;
    }

    getCurrentChatCompact().abort({});
  }

  function abortChat({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId !== undefined) {
      const chatGeneration = useChatGeneration({
        chatId: createScopedChatId({ chatId }),
      });
      chatGeneration.abort({});
      return;
    }

    getCurrentChatGeneration().abort({});
  }

  async function compactCurrentBranch({
    keepRecentMessages,
    instructionOverride,
  }: {
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }) {
    return await getCurrentChatCompact().run({
      keepRecentMessages,
      instructionOverride,
    });
  }

  async function compactCurrentBranchForChat({
    chatId,
    keepRecentMessages,
    instructionOverride,
  }: {
    chatId: string;
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }) {
    const chatCompact = useChatCompact({
      chatId: createScopedChatId({ chatId }),
    });
    return await chatCompact.run({
      keepRecentMessages,
      instructionOverride,
    });
  }

  async function forkChat({
    messageId,
    chatId,
  }: {
    messageId: string;
    chatId?: string;
  }): Promise<string | null> {
    if (chatId !== undefined) {
      const chatHistory = useChatHistory({
        chatId: createScopedChatId({ chatId }),
      });
      return await chatHistory.forkChat({
        messageId,
      });
    }

    return await getCurrentChatHistory().forkChat({
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
    const chatHistory = useChatHistory({
      chatId: createScopedChatId({ chatId }),
    });
    return await chatHistory.forkChat({
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
    await getCurrentChatHistory().editMessage({
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
    const chatHistory = useChatHistory({
      chatId: createScopedChatId({ chatId }),
    });
    await chatHistory.editMessage({
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
    await getCurrentChatHistory().switchVersion({
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
    const chatHistory = useChatHistory({
      chatId: createScopedChatId({ chatId }),
    });
    await chatHistory.switchVersion({
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
    await getCurrentChatGeneration().regenerateMessage({
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
    const chatGeneration = useChatGeneration({
      chatId: createScopedChatId({ chatId }),
    });
    await chatGeneration.regenerateMessage({
      failedMessageId,
    });
  }

  async function toggleDebug(_args: Record<never, never>) {
    const currentChatId = chatCurrentBridge.getCurrentChatId({});
    if (currentChatId === null) {
      return;
    }

    await chatMetadata.toggleDebug({
      chatId: currentChatId,
    });
  }

  async function toggleDebugForChat({
    chatId,
  }: {
    chatId: string;
  }) {
    await chatMetadata.toggleDebug({
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
    await chatMetadata.updateReasoningEffort({
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
    return await getCurrentChatImageGeneration().sendImageRequest({
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
    loadChats: loadData, fetchAvailableModels, createNewChat, openChat, openChatAtMessage, openChatGroup, deleteChat, deleteAllChats, renameChat, updateChatModel, updateChatGroupOverride, updateChatSettings, generateChatTitle, sendMessage, sendMessageForChat, regenerateMessage, regenerateMessageForChat, forkChat, forkChatForChat, editMessage, editMessageForChat, switchVersion, switchVersionForChat, getSiblings, toggleDebug, toggleDebugForChat, commitFullHistoryManipulation, generateImage, generateResponse, handleImageGeneration, sendImageRequest, sendImageRequestForChat, createChatGroup, deleteChatGroup, duplicateChatGroup, setChatGroupCollapsed, renameChatGroup, updateChatGroupMetadata, persistSidebarStructure, abortChat, abortTitleGeneration, updateChatMeta, updateChatContent, moveChatToGroup, addMountToChat, removeMountFromChat, updateChatMount, addMountToChatGroup, removeMountFromChatGroup, updateChatGroupMount, compactCurrentBranch, compactCurrentBranchForChat, abortContextCompact, getContextCompactProgress,
    registerLiveInstance, unregisterLiveInstance, getLiveChat, isTaskRunning, isProcessing, isGeneratingTitle, ensureChatTmpDirectory, getChatTmpDirectory,
    getVolatileToolOutput,
    chatFlow, isThinkingActive, isWaitingResponse, contextCompactProgress,
    TEST_ONLY: {
      liveChatRegistry,
      activeGenerations: chatRuntimeStore.activeGenerations,
      externalGenerations: chatRuntimeStore.externalGenerations,
      activeTitleGenerations: chatRuntimeStore.activeTitleGenerations,
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
