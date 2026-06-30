import { computed, type ComputedRef } from 'vue';
import type { Attachment, Chat, EndpointType, LmParameters, MessageNode, Mount, Reasoning, Settings } from '@/01-models/types';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';
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
  generateImageForChat,
  handleImageGenerationForChat,
  sendImageRequestForChat as sendImageRequestForChatImpl,
} from '@/composables/chat/chat-scoped/chat-image-flow';
import { useChatBranches } from '@/composables/chat/useChatBranches';
import { useChatCompaction } from '@/composables/chat/useChatCompaction';
import { useChatConversation } from '@/composables/chat/useChatConversation';
import { useChatMetadata } from '@/composables/chat/useChatMetadata';
import { useChatModels } from '@/composables/chat/useChatModels';
import { useChatTitle as useOwnedChatTitle } from '@/composables/chat/useChatTitle';
import {
  generateResponseForAssistant,
  sendMessageToTargetChat,
} from '@/composables/chat/chat-scoped/chat-generation-flow';
import {
  commitFullHistoryManipulationForChat,
} from '@/composables/chat/chat-scoped/chat-history-flow';
import { getSiblingsInChatBranch } from '@/composables/chat/chat-branch-helpers';
import { useChatGroupMounts } from '@/composables/chat/useChatGroupMounts';
import { useChatMounts } from '@/composables/chat/useChatMounts';
import type { AddToastOptions } from '@/composables/chat/ui/useChatLifecycle';
import { useChatLifecycle } from '@/composables/chat/ui/useChatLifecycle';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import { useChatOrganization } from '@/composables/chat/ui/useChatOrganization';
import { useSidebarStructure } from '@/composables/chat/ui/useSidebarStructure';
import type { ChatId, MessageId } from '@/01-models/ids';
import { idToRaw, toChatGroupId, toChatId, toMessageId, toVolumeId } from '@/01-models/ids';
import type { ImageRequestParams } from '@/utils/image-generation';

export type { AddToastOptions } from '@/composables/chat/ui/useChatLifecycle';

// Compatibility facade used only by .test.ts files that still exercise the legacy useChat API.
// Production code should not add new useChat dependencies. Keep maintaining those .test.ts files
// through this facade for now, but put new features in an existing focused composable or a new one.
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
  const chatConversation = useChatConversation();
  const chatBranches = useChatBranches();
  const chatCompaction = useChatCompaction();
  const chatMetadata = useChatMetadata();
  const chatModelsOwner = useChatModels();
  const chatTitleOwner = useOwnedChatTitle();
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
    chatId: string,
    mount: Mount,
  }) {
    await useChatMounts().addMount({
      chatId: toChatId({ raw: chatId }),
      mount,
    });
  }

  async function removeMountFromChat({
    chatId,
    volumeId,
  }: {
    chatId: string,
    volumeId: string,
  }) {
    await useChatMounts().removeMount({
      chatId: toChatId({ raw: chatId }),
      volumeId: toVolumeId({ raw: volumeId }),
    });
  }

  async function updateChatMount({
    chatId,
    volumeId,
    readOnly,
  }: {
    chatId: string,
    volumeId: string,
    readOnly: boolean,
  }) {
    await useChatMounts().updateMount({
      chatId: toChatId({ raw: chatId }),
      volumeId: toVolumeId({ raw: volumeId }),
      readOnly,
    });
  }

  async function addMountToChatGroup({
    groupId,
    mount,
  }: {
    groupId: string,
    mount: Mount,
  }) {
    await useChatGroupMounts().addMount({
      chatGroupId: toChatGroupId({ raw: groupId }),
      mount,
    });
  }

  async function removeMountFromChatGroup({
    groupId,
    volumeId,
  }: {
    groupId: string,
    volumeId: string,
  }) {
    await useChatGroupMounts().removeMount({
      chatGroupId: toChatGroupId({ raw: groupId }),
      volumeId: toVolumeId({ raw: volumeId }),
    });
  }

  async function updateChatGroupMount({
    groupId,
    volumeId,
    mountPath,
    readOnly,
  }: {
    groupId: string,
    volumeId: string,
    mountPath: string,
    readOnly: boolean,
  }) {
    await useChatGroupMounts().updateMount({
      chatGroupId: toChatGroupId({ raw: groupId }),
      volumeId: toVolumeId({ raw: volumeId }),
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
    id: string,
    leafId?: string,
  }) {
    return await chatNavigation.openChat({
      chatId: toChatId({ raw: id }),
      leafId: leafId === undefined ? undefined : toMessageId({ raw: leafId }),
    });
  }

  async function openChatAtMessage({
    chatId,
    messageId,
  }: {
    chatId: string,
    messageId: string,
  }) {
    return await chatNavigation.openChatAtMessage({
      chatId: toChatId({ raw: chatId }),
      messageId: toMessageId({ raw: messageId }),
    });
  }

  function openChatGroup({
    id,
  }: {
    id: string | null,
  }) {
    chatNavigation.openChatGroup({
      groupId: id === null ? null : toChatGroupId({ raw: id }),
    });
  }

  async function createNewChat({
    groupId,
    modelId,
    systemPrompt,
  }: {
    groupId: string | undefined,
    modelId: string | undefined,
    systemPrompt: Chat['systemPrompt'],
  }) {
    return await chatLifecycle.createNewChat({
      groupId: groupId === undefined ? undefined : toChatGroupId({ raw: groupId }),
      modelId,
      systemPrompt,
    });
  }

  async function deleteChat({
    id,
    injectAddToast,
  }: {
    id: string,
    injectAddToast?: (({ message, actionLabel, onAction, onClose, duration }: AddToastOptions) => string) | undefined,
  }) {
    await chatLifecycle.deleteChat({
      id: toChatId({ raw: id }),
      injectAddToast,
    });
  }

  async function deleteAllChats() {
    await chatLifecycle.deleteAllChats();
  }

  async function renameChat({
    id,
    newTitle,
  }: {
    id: string,
    newTitle: string,
  }) {
    await chatMetadata.rename({
      chatId: toChatId({ raw: id }),
      title: newTitle,
    });
  }

  async function updateChatModel({
    id,
    modelId,
  }: {
    id: string,
    modelId: string | undefined,
  }) {
    await chatMetadata.updateModel({
      chatId: toChatId({ raw: id }),
      modelId,
    });
  }

  async function updateChatGroupOverride({
    id,
    groupId,
  }: {
    id: string,
    groupId: string | null,
  }) {
    await chatMetadata.updateGroupOverride({
      chatId: toChatId({ raw: id }),
      chatGroupId: groupId === null ? undefined : toChatGroupId({ raw: groupId }),
    });
  }

  async function updateChatSettings({
    id,
    updates,
  }: {
    id: string,
    updates: Partial<Pick<Chat, 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>,
  }) {
    await chatMetadata.updateSettings({
      chatId: toChatId({ raw: id }),
      updates,
    });
  }

  function getReasoningEffort({
    chatId,
  }: {
    chatId: string,
  }) {
    return chatMetadata.reasoningEffort({
      chatId: computed(() => toChatId({ raw: chatId })),
    }).value;
  }

  const availableModels = sharedAvailableModels;

  async function fetchAvailableModels({
    chatId,
    customEndpoint,
  }: {
    chatId: string | undefined,
    customEndpoint?: {
      type: EndpointType,
      url: string,
      headers: readonly (readonly [string, string])[] | undefined,
    } | undefined,
  }) {
    if (customEndpoint !== undefined) {
      const endpoint = (() => {
        switch (customEndpoint.type) {
        case 'openai':
        case 'ollama':
          return {
            type: customEndpoint.type,
            url: customEndpoint.url,
            httpHeaders: customEndpoint.headers
              ? customEndpoint.headers.map(([name, value]) => [name, value] as [string, string])
              : undefined,
          };
        case 'transformers_js':
          return { type: customEndpoint.type };
        default: {
          const _ex: never = customEndpoint.type;
          throw new Error(`Unhandled endpoint type: ${_ex}`);
        }
        }
      })();
      return await chatModelsOwner.fetchForEndpoint({
        endpoint,
      });
    }

    if (chatId === undefined) {
      const currentChatId = chatCurrentBridge.getCurrentChatId();
      if (currentChatId !== null) {
        return await chatModelsOwner.fetchForChat({
          chatId: currentChatId,
        });
      }

      return await chatModelsOwner.fetchForGlobalEndpoint();
    }

    return await chatModelsOwner.fetchForChat({
      chatId: toChatId({ raw: chatId }),
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
    chatId: string,
    assistantId: string,
    prompt: string,
    width: number,
    height: number,
    count: number,
    steps: number | undefined,
    seed: number | 'browser_random' | undefined,
    persistAs: ImageRequestParams['persistAs'] | undefined,
    images: { blob: Blob }[],
    model: string | undefined,
    signal: AbortSignal | undefined,
  }) {
    const chat = chatCurrentBridge.getChatTargetById({ id: toChatId({ raw: chatId }) });
    if (chat === null) {
      return;
    }

    const resolved = resolveChatSettings({ chat, groups: chatGroups.value, globalSettings: settings.value });
    const endpoint = (() => {
      switch (resolved.endpoint.type) {
      case 'ollama':
        return resolved.endpoint;
      case 'openai':
      case 'transformers_js':
        throw new Error('Image generation requires an Ollama endpoint');
      default: {
        const _ex: never = resolved.endpoint;
        throw new Error(`Unhandled endpoint: ${String(_ex)}`);
      }
      }
    })();

    await handleImageGenerationForChat({
      chatId: toChatId({ raw: chatId }),
      assistantId: toMessageId({ raw: assistantId }),
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
      endpointUrl: endpoint.url,
      endpointHttpHeaders: endpoint.httpHeaders?.map(([name, value]) => [name, value]),
      storageType: settings.value.storageType,
      signal,
      getLiveChat,
      updateChatContent: async ({ chatId, updater }) => {
        await updateChatContent({
          id: chatId,

          updater: ({ current }) => {
            if (current === null) {
              throw new Error('Chat content not found');
            }
            return updater({ current: current });
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
    chatId: ChatId,
    prompt: string,
    width: number,
    height: number,
    count: number,
    steps: number | undefined,
    seed: number | 'browser_random' | undefined,
    persistAs: ImageRequestParams['persistAs'],
    attachments: Attachment[],
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
          chatId: chatId,
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
    chatId: string | undefined,
    signal: AbortSignal | undefined,
    titleModelIdOverride: string | undefined,
  }) {
    if (chatId === undefined) {
      return undefined;
    }

    if (signal !== undefined) {
      return await chatTitleOwner.generateTitle({
        chatId: toChatId({ raw: chatId }),
        signal,
        titleModelIdOverride,
      });
    }

    return await chatTitleOwner.generateTitle({
      chatId: toChatId({ raw: chatId }),
      signal: undefined,
      titleModelIdOverride,
    });
  }

  function abortTitleGeneration({
    chatId,
  }: {
    chatId: string | undefined,
  }) {
    if (chatId !== undefined) {
      chatTitleOwner.abortTitleGeneration({
        chatId: toChatId({ raw: chatId }),
      });
      return;
    }

    const currentChatId = chatCurrentBridge.getCurrentChatId();
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
    chat: Chat | Readonly<Chat>,
    assistantId: string,
    lmParameters?: LmParameters,
    onReady?: () => void,
  }): Promise<void> {
    await generateResponseForAssistant({
      chat,
      assistantId: toMessageId({ raw: assistantId }),
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
    content: string,
    parentId?: string | null,
    attachments?: Attachment[],
    chatTarget?: Chat | Readonly<Chat>,
    lmParameters?: LmParameters,
  }): Promise<boolean> {
    if (chatTarget !== undefined) {
      return await sendMessageToTargetChat({
        targetChat: chatTarget,
        content,
        parentId: parentId === undefined || parentId === null ? parentId : toMessageId({ raw: parentId }),
        attachments,
        lmParameters,
      });
    }

    const currentChatId = chatCurrentBridge.getCurrentChatId();
    if (currentChatId === null) {
      return false;
    }

    return await chatConversation.sendMessage({
      chatId: currentChatId,
      content,
      parentId: parentId === undefined || parentId === null ? parentId : toMessageId({ raw: parentId }),
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
    chatId: ChatId,
    content: string,
    parentId: MessageId | null | undefined,
    attachments: Attachment[] | undefined,
    lmParameters: LmParameters | undefined,
  }): Promise<boolean> {
    return await chatConversation.sendMessage({
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
    chatId: string | undefined,
  }) {
    if (chatId !== undefined) {
      chatCompaction.abort({
        chatId: toChatId({ raw: chatId }),
      });
      return;
    }

    const currentChatId = chatCurrentBridge.getCurrentChatId();
    if (currentChatId === null) {
      return;
    }
    chatCompaction.abort({
      chatId: currentChatId,
    });
  }

  function abortChat({
    chatId,
  }: {
    chatId: string | undefined,
  }) {
    if (chatId !== undefined) {
      chatConversation.abort({
        chatId: toChatId({ raw: chatId }),
      });
      return;
    }

    const currentChatId = chatCurrentBridge.getCurrentChatId();
    if (currentChatId === null) {
      return;
    }
    chatConversation.abort({
      chatId: currentChatId,
    });
  }

  async function compactCurrentBranch({
    keepRecentMessages,
    instructionOverride,
  }: {
    keepRecentMessages: number,
    instructionOverride: string | undefined,
  }) {
    const currentChatId = chatCurrentBridge.getCurrentChatId();
    if (currentChatId === null) {
      return false;
    }

    return await chatCompaction.compactCurrentBranch({
      chatId: currentChatId,
      keepRecentMessages,
      instructionOverride,
    });
  }

  async function compactCurrentBranchForChat({
    chatId,
    keepRecentMessages,
    instructionOverride,
  }: {
    chatId: string,
    keepRecentMessages: number,
    instructionOverride: string | undefined,
  }) {
    return await chatCompaction.compactCurrentBranch({
      chatId: toChatId({ raw: chatId }),
      keepRecentMessages,
      instructionOverride,
    });
  }

  async function forkChat({
    messageId,
    chatId,
  }: {
    messageId: string,
    chatId?: string,
  }): Promise<string | null> {
    if (chatId !== undefined) {
      const forkedChatId = await chatBranches.forkChat({
        chatId: toChatId({ raw: chatId }),
        messageId: toMessageId({ raw: messageId }),
      });
      return forkedChatId === null ? null : idToRaw({ id: forkedChatId });
    }

    const currentChatId = chatCurrentBridge.getCurrentChatId();
    if (currentChatId === null) {
      return null;
    }
    const forkedChatId = await chatBranches.forkChat({
      chatId: currentChatId,
      messageId: toMessageId({ raw: messageId }),
    });
    return forkedChatId === null ? null : idToRaw({ id: forkedChatId });
  }

  async function forkChatForChat({
    chatId,
    messageId,
  }: {
    chatId: string,
    messageId: string,
  }): Promise<string | null> {
    const forkedChatId = await chatBranches.forkChat({
      chatId: toChatId({ raw: chatId }),
      messageId: toMessageId({ raw: messageId }),
    });
    return forkedChatId === null ? null : idToRaw({ id: forkedChatId });
  }

  async function editMessage({
    messageId,
    newContent,
    lmParameters,
  }: {
    messageId: string,
    newContent: string,
    lmParameters?: LmParameters,
  }): Promise<void> {
    const currentChatId = chatCurrentBridge.getCurrentChatId();
    if (currentChatId === null) {
      return;
    }
    await chatBranches.editMessage({
      chatId: currentChatId,
      messageId: toMessageId({ raw: messageId }),
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
    chatId: string,
    messageId: string,
    newContent: string,
    lmParameters?: LmParameters,
  }): Promise<void> {
    await chatBranches.editMessage({
      chatId: toChatId({ raw: chatId }),
      messageId: toMessageId({ raw: messageId }),
      newContent,
      lmParameters,
    });
  }

  async function switchVersion({
    messageId,
  }: {
    messageId: string,
  }): Promise<void> {
    const currentChatId = chatCurrentBridge.getCurrentChatId();
    if (currentChatId === null) {
      return;
    }
    await chatBranches.switchVersion({
      chatId: currentChatId,
      messageId: toMessageId({ raw: messageId }),
    });
  }

  async function switchVersionForChat({
    chatId,
    messageId,
  }: {
    chatId: string,
    messageId: string,
  }): Promise<void> {
    await chatBranches.switchVersion({
      chatId: toChatId({ raw: chatId }),
      messageId: toMessageId({ raw: messageId }),
    });
  }

  function getSiblings({
    messageId,
    chatId,
  }: {
    messageId: string,
    chatId?: string,
  }): MessageNode[] {
    const targetChat = chatId !== undefined
      ? chatCurrentBridge.getChatTargetById({ id: toChatId({ raw: chatId }) })
      : chatCurrentBridge.getCurrentChat();
    if (targetChat === null) {
      return [];
    }

    return [...getSiblingsInChatBranch({
      root: targetChat.root,
      messageId: toMessageId({ raw: messageId }),
    })];
  }

  async function regenerateMessage({
    failedMessageId,
  }: {
    failedMessageId: string,
  }): Promise<void> {
    const currentChatId = chatCurrentBridge.getCurrentChatId();
    if (currentChatId === null) {
      return;
    }
    await chatConversation.regenerateMessage({
      chatId: currentChatId,
      failedMessageId: toMessageId({ raw: failedMessageId }),
    });
  }

  async function regenerateMessageForChat({
    chatId,
    failedMessageId,
  }: {
    chatId: string,
    failedMessageId: string,
  }): Promise<void> {
    await chatConversation.regenerateMessage({
      chatId: toChatId({ raw: chatId }),
      failedMessageId: toMessageId({ raw: failedMessageId }),
    });
  }

  async function toggleDebug() {
    const currentChatId = chatCurrentBridge.getCurrentChatId();
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
    chatId: string,
  }) {
    await chatMetadata.toggleDebug({
      chatId: toChatId({ raw: chatId }),
    });
  }

  async function updateReasoningEffort({
    chatId,
    effort,
  }: {
    chatId: string,
    effort: Reasoning['effort'],
  }) {
    await chatMetadata.updateReasoningEffort({
      chatId: toChatId({ raw: chatId }),
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
    prompt: string,
    model: string,
    width: number,
    height: number,
    steps: number | undefined,
    seed: number | undefined,
    images: { blob: Blob }[],
    chat: Chat,
    signal: AbortSignal | undefined,
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
    prompt: string,
    width: number,
    height: number,
    count: number,
    steps: number | undefined,
    seed: number | 'browser_random' | undefined,
    persistAs: ImageRequestParams['persistAs'],
    attachments: Attachment[],
  }) {
    const currentChatId = chatCurrentBridge.getCurrentChatId();
    if (currentChatId === null) {
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
    clearLiveChatRegistryImpl: () => {
      liveChatRegistry.clear();
    },
  });
  const __testOnlySetCurrentChat = chatTestSupport.__testOnlySetCurrentChat;
  const __testOnlySetCurrentChatGroup = chatTestSupport.__testOnlySetCurrentChatGroup;
  const __testOnlySetContextCompactProgress = chatTestSupport.__testOnlySetContextCompactProgress;
  const clearLiveChatRegistry = chatTestSupport.clearLiveChatRegistry;

  const clearActiveTaskCounts = () => {
    chatRuntimeStore.clearActiveTaskCounts();
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
    ...((__BUILD_MODE_IS_TEST__ && {
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
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
