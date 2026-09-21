import { reactive, toRaw } from 'vue';
import { ensureStrings } from '@/strings';
import type { AssistantMessageNode, Attachment, Chat, ChatGroup, Endpoint, EndpointType, LmParameters, MessageNode, Settings, ToolMessageNode, UserMessageNode } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { isConfiguredEndpoint } from '@/01-models/endpoint';
import type { LmProvider } from '@/01-models/lm';
import { type Tool } from '@/01-models/tool';
import { loadLmProvider } from '@/features/lm/providerFactory';
import { promptApiRuntimeState } from '@/features/prompt-api/runtime';
import { storageService } from '@/00-storage/service';
import { getEnabledTools } from '@/features/tools/factory';
import { findLastToolConfigByKey, lmToolNamesFromToolConfigs } from '@/features/tools/tool-config';
import { getEffectiveToolConfigsForChat } from '@/features/tools/composables/useChatTools';
import { shouldIncludeWritableTmpMount } from '@/features/wesh/mount-policy';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';
import {
  findNodeInBranch,
  findParentInBranch,
  getChatBranchIterator,
} from '@/logic/chat-tree';
import { generateId } from '@/01-models/id';
import { buildChatGenerationMessages } from '@/logic/build-chat-generation-messages';
import { getMessageText } from '@/01-models/message-text';
import { generateChatTurn } from '@/logic/generate-chat-turn';
import {
  SENTINEL_IMAGE_PENDING,
  createImageRequestMarker,
  createImageResponseMarker,
  isImageRequest,
  parseImageRequest,
  stripNaidanSentinels,
  type ImageRequestParams,
} from '@/utils/image-generation';
import { useConfirm } from '@/composables/useConfirm';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { useImageGeneration } from '@/composables/useImageGeneration';
import { useSettings } from '@/composables/useSettings';
import { useStoragePersistence } from '@/composables/useStoragePersistence';
import { useToast } from '@/composables/useToast';
import { useApproval } from '@/features/tools/composables/useApproval';
import { useChoices } from '@/features/tools/composables/useChoices';
import {
  availableModels,
  chatRuntimeStore,
  chatVolatileState,
  currentChatGroupRef,
  currentChatRef,
  ensureChatTmpDirectory,
  getLiveChat,
  getLiveChatById,
  isProcessing,
  loadData,
  registerLiveInstance,
  rootItems,
  triggerCurrentChat as notifyChatChanged,
  updateChatContent,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';
import {
  generateChatTitleForChat,
} from '@/composables/chat/chat-scoped/chat-title-flow';
import {
  abortProcessingForChat,
} from '@/composables/chat/chat-scoped/chat-processing-abort';
import {
  handleImageGenerationForChat,
} from '@/composables/chat/chat-scoped/chat-image-flow';
import {
  fetchAvailableModelsForChat,
} from '@/composables/chat/chat-scoped/chat-model-flow';
import {
  useChatNavigation,
} from '@/composables/chat/ui/useChatNavigation';
import type { BinaryObjectId, ChatId, MessageId, ToolCallId } from '@/01-models/ids';
import { idToRaw } from '@/01-models/ids';
import {
  useChatOrganization,
} from '@/composables/chat/ui/useChatOrganization';

type PersistedToolContent =
  | { type: 'text', text: string }
  | { type: 'binary_object', id: BinaryObjectId };

type ResolvedGenerationSettings = {
  endpoint: Endpoint,
  modelId: string,
  lmParameters: LmParameters | undefined,
  systemPromptMessages: string[],
  autoTitleEnabled: boolean,
};

function isBrowserProvidedLmEndpoint({ endpoint }: { endpoint: Endpoint }): boolean {
  switch (endpoint.type) {
  case 'browser_provided_lm':
    return true;
  case 'openai':
  case 'ollama':
  case 'llama_cpp_browser':
  case 'transformers_js':
  case 'unsupported_experimental_endpoint':
    return false;
  default: {
    const _ex: never = endpoint;
    throw new Error(`Unhandled endpoint: ${String(_ex)}`);
  }
  }
}

function resolveGenerationModel({
  assistantModelId,
  resolvedModelId,
  availableModels,
}: {
  assistantModelId: string | undefined,
  resolvedModelId: string,
  availableModels: readonly string[],
}): string {
  const preferredModel = assistantModelId || resolvedModelId;
  if (!preferredModel || availableModels.length === 0) return preferredModel;
  if (availableModels.includes(preferredModel)) return preferredModel;
  return availableModels[0] ?? '';
}

export async function sendMessageForChat({
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
  const targetChat = getLiveChatById({ chatId });
  return await sendMessageToTargetChat({
    targetChat,
    content,
    parentId,
    attachments,
    lmParameters,
  });
}

export async function sendMessageToCurrentChat({
  content,
  parentId,
  attachments,
  lmParameters,
}: {
  content: string,
  parentId: MessageId | null | undefined,
  attachments: Attachment[] | undefined,
  lmParameters: LmParameters | undefined,
}): Promise<boolean> {
  return await sendMessageToTargetChat({
    targetChat: currentChatRef.value,
    content,
    parentId,
    attachments,
    lmParameters,
  });
}

export async function sendMessageToTargetChat({
  targetChat,
  content,
  parentId,
  attachments,
  lmParameters,
}: {
  targetChat: Chat | Readonly<Chat> | null,
  content: string,
  parentId: MessageId | null | undefined,
  attachments: Attachment[] | undefined,
  lmParameters: LmParameters | undefined,
}): Promise<boolean> {
  if (targetChat === null) {
    return false;
  }

  if (isProcessing({ chatId: targetChat.id })) {
    return false;
  }

  const normalizedAttachments = attachments ?? [];
  const mutableChat = getLiveChat({ chat: targetChat });
  chatRuntimeStore.startTask({ key: { kind: 'process', chatId: mutableChat.id } });
  registerLiveInstance({ chat: mutableChat });

  try {
    const resolved = resolveGenerationSettings({
      chat: mutableChat,
    });
    const endpoint = resolved.endpoint;
    const { hasReachableEndpoint, url, type }: {
      hasReachableEndpoint: boolean,
      url: string | undefined,
      type: EndpointType | undefined,
    } = (() => {
      switch (endpoint.type) {
      case 'openai':
      case 'ollama':
        return {
          hasReachableEndpoint: endpoint.url !== '',
          url: endpoint.url,
          type: endpoint.type,
        };
      case 'llama_cpp_browser':
      case 'transformers_js':
      case 'browser_provided_lm':
        return {
          hasReachableEndpoint: true,
          url: undefined,
          type: endpoint.type,
        };
      case 'unsupported_experimental_endpoint':
        return {
          hasReachableEndpoint: false,
          url: undefined,
          type: undefined,
        };
      default: {
        const _ex: never = endpoint;
        throw new Error(`Unhandled endpoint: ${String(_ex)}`);
      }
      }
    })();
    const usesBrowserProvidedLm = isBrowserProvidedLmEndpoint({ endpoint });
    const models = hasReachableEndpoint
      ? await fetchAvailableModelsForChat({
        chatId: mutableChat.id,
        errorSource: 'chat-generation-flow:resolve-models',
      })
      : [];
    const resolvedModel = resolveGenerationModel({
      assistantModelId: mutableChat.modelId,
      resolvedModelId: resolved.modelId,
      availableModels: models,
    });

    if (!hasReachableEndpoint || !resolvedModel) {
      if (type !== undefined) {
        showOnboardingDraft({
          url,
          type,
          models: await fetchAvailableModelsForChat({
            chatId: mutableChat.id,
            errorSource: 'chat-generation-flow:show-onboarding',
          }),
        });
      }
      return false;
    }

    if (usesBrowserProvidedLm && promptApiRuntimeState.value.status !== 'ready') {
      return false;
    }

    const effectiveLmParameters = usesBrowserProvidedLm
      ? undefined
      : lmParameters;

    const processedAttachments: Attachment[] = [];
    if (normalizedAttachments.length > 0 && !storageService.canPersistBinary) {
      const confirmed = await confirmTemporaryAttachments();
      if (!confirmed) {
        return false;
      }
      useSettings().setHeavyContentAlertDismissed?.({ dismissed: true });
    }

    for (const attachment of normalizedAttachments) {
      processedAttachments.push(await persistAttachment({ attachment }));
    }

    const imageGeneration = useImageGeneration();
    const imageModeEnabled = imageGeneration.isImageMode({ chatId: mutableChat.id });
    const imageModel = imageModeEnabled
      ? imageGeneration.getSelectedImageModel({ chatId: mutableChat.id, availableModels: availableModels.value })
      : undefined;
    const resolution = imageGeneration.getResolution({ chatId: mutableChat.id });
    const count = imageGeneration.getCount({ chatId: mutableChat.id });
    const steps = imageGeneration.getSteps({ chatId: mutableChat.id });
    const seed = imageGeneration.getSeed({ chatId: mutableChat.id });
    const persistAs = imageGeneration.getPersistAs({ chatId: mutableChat.id });

    let finalContent = content;
    if (imageModeEnabled && !isImageRequest({ content })) {
      if (!imageModel) {
        useGlobalEvents().addErrorEvent({
          source: 'useChat:sendMessage',
          message: await ensureStrings.chatGenerationFlow__no_image_generation_model_was_found(),
        });
        return false;
      }
      finalContent = createImageRequestMarker({
        ...resolution,
        model: imageModel,
        count,
        steps,
        seed: seed === 'browser_random' ? 'browser_random' : seed,
        persistAs,
      }) + content;
    }

    const userMessage: UserMessageNode = {
      id: generateId<MessageId>(), role: 'user', createdAt: Date.now(),
      parts: [
        { id: 'text', type: 'text', text: finalContent, completeness: 'complete' },
        ...processedAttachments.map((attachment, index) => ({ id: `attachment_${index}`, type: 'attachment' as const, attachment })),
      ],
      replies: { items: [] }, modelId: undefined,
      lmParameters: effectiveLmParameters || EMPTY_LM_PARAMETERS,
    };

    const assistantMessage: AssistantMessageNode = {
      id: generateId<MessageId>(), role: 'assistant', createdAt: Date.now(),
      parts: imageModeEnabled ? [{ id: 'text', type: 'text', text: createImageResponseMarker({ count }) + SENTINEL_IMAGE_PENDING, completeness: 'partial' }] : [],
      modelId: imageModel || resolvedModel, replies: { items: [] },
      lmParameters: effectiveLmParameters || EMPTY_LM_PARAMETERS,
      interruption: undefined,
    };
    userMessage.replies.items.push(assistantMessage);

    if (!mutableChat.root) {
      mutableChat.root = { items: [] };
    }

    if (parentId === null) {
      mutableChat.root.items.push(userMessage);
    } else {
      const candidateParentId = parentId || mutableChat.currentLeafId;
      const parentNode = candidateParentId
        ? findNodeInBranch({ items: mutableChat.root.items, targetId: candidateParentId })
        : null;
      if (parentNode) {
        parentNode.replies.items.push(userMessage);
      } else {
        mutableChat.root.items.push(userMessage);
      }
    }

    mutableChat.currentLeafId = assistantMessage.id;
    notifyChatChanged({ chatId: mutableChat.id });
    await updateChatContent({
      id: mutableChat.id,

      updater: ({ current }) => ({
        ...(current || {}),
        root: mutableChat.root,
        currentLeafId: mutableChat.currentLeafId,
      }),
    });
    await updateChatMeta({
      id: mutableChat.id,

      updater: ({ current }) => {
        if (current === null) {
          return mutableChat;
        }
        return { ...current, updatedAt: Date.now(), currentLeafId: mutableChat.currentLeafId };
      },
    });
    await useChatOrganization().reorderSidebarChatAfterSend({ chatId: mutableChat.id });

    let markGenerationReady: (() => void) | undefined;
    const generationReady = new Promise<void>((resolve) => {
      markGenerationReady = resolve;
    });
    generateResponseForAssistant({
      chat: mutableChat,
      assistantId: assistantMessage.id,
      lmParameters: effectiveLmParameters,
      onReady: () => {
        markGenerationReady?.();
        markGenerationReady = undefined;
      },
    }).catch((error) => {
      markGenerationReady?.();
      markGenerationReady = undefined;
      console.error('Background generation failed:', error);
    });
    await generationReady;
    return true;
  } finally {
    chatRuntimeStore.finishTask({ key: { kind: 'process', chatId: mutableChat.id } });
  }
}

export async function generateResponseForAssistant({
  chat,
  assistantId,
  lmParameters,
  onReady,
}: {
  chat: Chat | Readonly<Chat>,
  assistantId: MessageId,
  lmParameters: LmParameters | undefined,
  onReady: (() => void) | undefined,
}): Promise<void> {
  let didSignalReady = false;
  const signalReady = () => {
    if (didSignalReady) {
      return;
    }
    didSignalReady = true;
    onReady?.();
  };

  const mutableChat = getLiveChat({ chat });
  const debug = mutableChat.debugEnabled ? 'on' : 'off';
  const assistantNode = findNodeInBranch({ items: mutableChat.root.items, targetId: assistantId });
  if (assistantNode === null || assistantNode.role !== 'assistant') {
    throw new Error('Assistant node not found');
  }

  if (chatRuntimeStore.getActiveGeneration({ chatId: mutableChat.id }) !== undefined) {
    throw new Error('This chat already owns an active generation.');
  }
  const originalParent = findParentInBranch({ items: mutableChat.root.items, childId: assistantId });
  const originalImageRequest = originalParent ? parseImageRequest({ content: getMessageText({ message: originalParent }) }) : null;
  if (assistantNode.parts.length !== 0 && !originalImageRequest) {
    throw new Error('Existing assistant content cannot be resumed by a new generation.');
  }
  chatVolatileState.clearVolatileAssistantError({
    chatId: mutableChat.id,
    messageId: assistantNode.id,
  });
  notifyChatChanged({ chatId: mutableChat.id });

  const controller = new AbortController();
  chatRuntimeStore.setActiveGeneration({
    chatId: mutableChat.id,
    generation: { controller, chat: mutableChat },
  });
  storageService.notify({
    event: {
      type: 'chat_content_generation',
      id: idToRaw({ id: mutableChat.id }),
      status: 'started',
      timestamp: Date.now(),
    },
  });
  registerLiveInstance({ chat: mutableChat });

  let activeAssistant = assistantNode;
  let ownedLeaf: MessageNode = assistantNode;
  const ownedTools: ToolMessageNode[] = [];
  const currentGenerationToolCallIds = new Set<ToolCallId>();
  let persistenceFailure: unknown;
  let lastSave = 0;
  async function saveContent(): Promise<void> {
    try {
      await updateChatContent({
        id: mutableChat.id,
        updater: ({ current }) => ({ ...(current || {}), root: mutableChat.root, currentLeafId: mutableChat.currentLeafId }),
      });
      lastSave = Date.now();
    } catch (error) {
      persistenceFailure = error;
      throw error;
    }
  }
  async function reflectChanges(): Promise<void> {
    for (const node of ownedTools) {
      for (const part of node.parts) {
        switch (part.result.status) {
        case 'success':
        case 'error': chatVolatileState.deleteVolatileToolOutput({ toolCallId: part.result.toolCallId }); break;
        case 'executing': break;
        default: { const _ex: never = part.result; throw new Error(`Unhandled tool result: ${_ex}`); }
        }
      }
    }
    notifyChatChanged({ chatId: mutableChat.id });
    // The consumer serializes this callback; UI updates never race a prior save.
    if (Date.now() - lastSave > 500) await saveContent();
  }

  try {
    const resolved = resolveGenerationSettings({ chat: mutableChat });
    const usesBrowserProvidedLm = isBrowserProvidedLmEndpoint({ endpoint: resolved.endpoint });
    const availableGenerationModels = await fetchAvailableModelsForChat({
      chatId: mutableChat.id,
      errorSource: 'chat-generation-flow:resolve-regeneration-model',
    });
    const resolvedModel = resolveGenerationModel({
      assistantModelId: assistantNode.modelId,
      resolvedModelId: resolved.modelId,
      availableModels: availableGenerationModels,
    });
    const finalLmParameters = usesBrowserProvidedLm
      ? undefined
      : (lmParameters || resolved.lmParameters);

    assistantNode.lmParameters = finalLmParameters;
    assistantNode.modelId = resolvedModel;

    const parentNode = findParentInBranch({ items: mutableChat.root.items, childId: assistantId });
    const imageRequest = parentNode ? parseImageRequest({ content: getMessageText({ message: parentNode }) }) : null;
    if (imageRequest) {
      const { width = 512, height = 512, model, count = 1, persistAs, steps, seed } = imageRequest;
      const prompt = stripNaidanSentinels({ content: parentNode ? getMessageText({ message: parentNode }) : '' }).trim();

      const images: { blob: Blob }[] = [];
      if (parentNode) {
        switch (parentNode.role) {
        case 'user':
          for (const part of parentNode.parts) {
            switch (part.type) {
            case 'attachment': {
              const blob = await resolveAttachmentBlob({ attachment: part.attachment });
              if (blob !== null && part.attachment.mimeType.startsWith('image/')) images.push({ blob });
              break;
            }
            case 'text': break;
            default: { const _ex: never = part; throw new Error(`Unhandled user part: ${_ex}`); }
            }
          }
          break;
        case 'assistant':
        case 'tool':
        case 'system': break;
        default: { const _ex: never = parentNode; throw new Error(`Unhandled message: ${_ex}`); }
        }
      }

      signalReady();
      await handleImageGenerationWithDefaults({
        chatId: mutableChat.id,
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
        signal: controller.signal,
      });
      return;
    }

    controller.signal.throwIfAborted();
    const provider = await loadGenerationProvider({
      endpoint: resolved.endpoint,
    });
    controller.signal.throwIfAborted();
    const enabledTools = await getEnabledToolsForChat({ chat: mutableChat });
    let reservedAssistant: AssistantMessageNode | undefined = assistantNode;

    try {
      controller.signal.throwIfAborted();
      signalReady();
      const { ensureApproval } = useApproval();
      const result = await generateChatTurn({
        provider, debug, model: resolvedModel, parameters: finalLmParameters, tools: enabledTools,
        abortController: controller,
        approvalContext: { chatId: mutableChat.id, ensureApproval },
        readBinaryObject: async ({ binaryObjectId, signal }) => {
          signal?.throwIfAborted();
          const blob = await storageService.getFile({ binaryObjectId });
          signal?.throwIfAborted();
          if (!blob) throw new Error('The referenced binary object is missing.');
          return blob;
        },
        createAssistantMessage: () => {
          if (reservedAssistant !== undefined) {
            const node = reservedAssistant;
            reservedAssistant = undefined;
            if (node.parts.length !== 0) throw new Error('Generation requires a new empty assistant message.');
            return node;
          }
          const node: AssistantMessageNode = reactive({
            id: generateId<MessageId>(), role: 'assistant', createdAt: Date.now(),
            parts: [], modelId: resolvedModel, lmParameters: finalLmParameters,
            interruption: undefined, replies: { items: [] },
          });
          ownedLeaf.replies.items.push(node);
          ownedLeaf = node;
          activeAssistant = node;
          mutableChat.currentLeafId = node.id;
          notifyChatChanged({ chatId: mutableChat.id });
          return node;
        },
        createToolMessage: ({ assistant }) => {
          if (assistant !== activeAssistant) throw new Error('The active assistant no longer owns this tool execution.');
          const node: ToolMessageNode = reactive({
            id: generateId<MessageId>(), role: 'tool', createdAt: Date.now(),
            parts: [], modelId: undefined, lmParameters: undefined, replies: { items: [] },
          });
          assistant.replies.items.push(node);
          ownedTools.push(node);
          ownedLeaf = node;
          mutableChat.currentLeafId = node.id;
          for (const part of assistant.parts) {
            switch (part.type) {
            case 'tool_call': currentGenerationToolCallIds.add(part.toolCall.id); break;
            case 'text':
            case 'reasoning': break;
            default: { const _ex: never = part; throw new Error(`Unhandled assistant part: ${_ex}`); }
            }
          }
          notifyChatChanged({ chatId: mutableChat.id });
          return node;
        },
        buildMessages: ({ excludedMessageId }) => buildChatGenerationMessages({
          // Branch navigation during generation must not change the run's input path.
          chat: { root: mutableChat.root, currentLeafId: ownedLeaf.id },
          excludedMessageId, systemPromptMessages: resolved.systemPromptMessages,
        }),
        onChange: reflectChanges,
        onToolEvent: ({ toolCallId, event }) => {
          switch (event.type) {
          case 'started': chatVolatileState.setVolatileToolOutput({ toolCallId, output: '' }); break;
          case 'output': chatVolatileState.appendVolatileToolOutput({ toolCallId, text: event.text }); break;
          case 'exit': break;
          default: { const _ex: never = event; throw new Error(`Unhandled tool event: ${_ex}`); }
          }
          notifyChatChanged({ chatId: mutableChat.id });
        },
        persistToolContent,
        describeError: ({ error }) => error.message,
      });
      await saveContent();
      mutableChat.updatedAt = Date.now();
      switch (result.type) {
      case 'error':
        chatVolatileState.setVolatileAssistantError({ chatId: mutableChat.id, messageId: activeAssistant.id, error: result.error.message });
        await showGenerationFailedToast({ chat: mutableChat });
        break;
      case 'interrupted':
        // A stop during tool execution may happen after its assistant was already complete.
        // Retain the observed tool outcome; do not rewrite the earlier assistant as partial.
        break;
      case 'finished':
        if (mutableChat.title === null && resolved.autoTitleEnabled && !controller.signal.aborted) {
          await generateChatTitleForChat({ chatId: mutableChat.id, signal: controller.signal, titleModelIdOverride: undefined });
        }
        break;
      default: { const _ex: never = result; throw new Error(`Unhandled generation result: ${_ex}`); }
      }
    } finally {
      await Promise.all(enabledTools.map(async tool => {
        await tool.dispose?.();
      }));
    }
  } catch (error) {
    signalReady();
    // Model errors are recorded by the common runner. Failures in storage, tool
    // observation, disposal, or title generation must not overwrite that outcome.
    const reason: unknown = controller.signal.reason;
    const userStop = controller.signal.aborted && reason instanceof DOMException && reason.name === 'AbortError';
    if (userStop) {
      if (activeAssistant.parts.length === 0 && ownedTools.length === 0 && activeAssistant.interruption === undefined) {
        activeAssistant.interruption = { type: 'cancelled' };
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      chatVolatileState.setVolatileAssistantError({ chatId: mutableChat.id, messageId: activeAssistant.id, error: message });
      console.error('[useChat] Generation operation failed:', { chatId: mutableChat.id, assistantId: activeAssistant.id, error: message });
      await showGenerationFailedToast({ chat: mutableChat });
    }
    notifyChatChanged({ chatId: mutableChat.id });
    // Keep accepted in-memory content on persistence failure; do not invent an
    // empty replacement or append an error notice to model-visible text.
    if (persistenceFailure === undefined) await saveContent();
  } finally {
    signalReady();
    for (const toolCallId of currentGenerationToolCallIds) chatVolatileState.deleteVolatileToolOutput({ toolCallId });
    if (chatRuntimeStore.getActiveGeneration({ chatId: mutableChat.id })?.controller === controller) {
      chatRuntimeStore.deleteActiveGeneration({ chatId: mutableChat.id });
      storageService.notify({
        event: {
          type: 'chat_content_generation',
          id: idToRaw({ id: mutableChat.id }),
          status: 'stopped',
          timestamp: Date.now(),
        },
      });
      // A failed content write must not be followed by a reload that replaces
      // the accepted in-memory answer with an older persisted snapshot.
      if (persistenceFailure === undefined) {
        updateChatMeta({
          id: mutableChat.id,
          updater: ({ current }) => {
            if (current === null) {
              return mutableChat;
            }
            return { ...current, updatedAt: Date.now(), currentLeafId: mutableChat.currentLeafId };
          },
        }).then(async () => {
          await loadData();
        }).catch(() => {});
      }

      const history = Array.from(getChatBranchIterator({ chat: mutableChat }));
      const assistantMessages = history.filter((message) => message.role === 'assistant');
      if (assistantMessages.length === 1) {
        useStoragePersistence().requestPersistence();
      }
    }
  }
}

export async function regenerateMessageForChat({
  chatId,
  failedMessageId,
}: {
  chatId: ChatId,
  failedMessageId: MessageId,
}): Promise<void> {
  const targetChat = getLiveChatById({ chatId });
  if (targetChat === null) {
    return;
  }

  await regenerateMessageForTarget({
    targetChat,
    failedMessageId,
  });
}

export async function regenerateMessageForCurrentChat({
  failedMessageId,
}: {
  failedMessageId: MessageId,
}): Promise<void> {
  if (currentChatRef.value === null) {
    return;
  }

  await regenerateMessageForTarget({
    targetChat: currentChatRef.value,
    failedMessageId,
  });
}

async function regenerateMessageForTarget({
  targetChat,
  failedMessageId,
}: {
  targetChat: Chat | Readonly<Chat>,
  failedMessageId: MessageId,
}): Promise<void> {
  const chatId = targetChat.id;
  if (isProcessing({ chatId })) {
    abortProcessingForChat({ chatId });
    while (isProcessing({ chatId })) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const mutableChat = getLiveChat({ chat: targetChat });
  chatRuntimeStore.startTask({ key: { kind: 'process', chatId: mutableChat.id } });
  registerLiveInstance({ chat: mutableChat });

  try {
    const failedNode = findNodeInBranch({ items: mutableChat.root.items, targetId: failedMessageId });
    if (failedNode === null || failedNode.role !== 'assistant') {
      return;
    }
    const parent = findParentInBranch({ items: mutableChat.root.items, childId: failedMessageId });
    if (parent === null) {
      return;
    }
    switch (parent.role) {
    case 'user':
      break;
    case 'tool':
      // Retry the answer from completed results, without repeating historical calls.
      if (parent.parts.length === 0 || parent.parts.some(({ result }) => {
        switch (result.status) {
        case 'executing':
          return true;
        case 'success':
        case 'error':
          return false;
        default: {
          const _ex: never = result;
          throw new Error(`Unhandled tool result: ${String(_ex)}`);
        }
        }
      })) {
        return;
      }
      break;
    case 'assistant':
    case 'system':
      return;
    default: {
      const _ex: never = parent;
      throw new Error(`Unhandled message parent: ${String(_ex)}`);
    }
    }

    const newAssistantMessage: AssistantMessageNode = {
      id: generateId<MessageId>(), role: 'assistant', createdAt: Date.now(),
      parts: [], interruption: undefined, modelId: failedNode.modelId,
      replies: { items: [] }, lmParameters: failedNode.lmParameters || EMPTY_LM_PARAMETERS,
    };
    parent.replies.items.push(newAssistantMessage);
    mutableChat.currentLeafId = newAssistantMessage.id;
    notifyChatChanged({ chatId: mutableChat.id });

    await updateChatContent({
      id: mutableChat.id,

      updater: ({ current }) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId }),
    });
    await updateChatMeta({
      id: mutableChat.id,

      updater: ({ current }) => {
        if (current === null) {
          return mutableChat;
        }
        return { ...current, updatedAt: Date.now(), currentLeafId: mutableChat.currentLeafId };
      },
    });

    let markGenerationReady: (() => void) | undefined;
    const generationReady = new Promise<void>((resolve) => {
      markGenerationReady = resolve;
    });
    generateResponseForAssistant({
      chat: mutableChat,
      assistantId: newAssistantMessage.id,
      lmParameters: failedNode.lmParameters,
      onReady: () => {
        markGenerationReady?.();
        markGenerationReady = undefined;
      },
    }).catch((error) => {
      markGenerationReady?.();
      markGenerationReady = undefined;
      console.error('Background generation failed:', error);
    });
    await generationReady;
  } finally {
    chatRuntimeStore.finishTask({ key: { kind: 'process', chatId: mutableChat.id } });
  }
}

function resolveGenerationSettings({
  chat,
}: {
  chat: Chat,
}): ResolvedGenerationSettings {
  const { settings } = useSettings();
  const resolved = resolveChatSettings({
    chat,
    groups: collectChatGroups({ items: rootItems.value }),
    globalSettings: settings.value,
  });
  return {
    endpoint: resolved.endpoint,
    modelId: resolved.modelId,
    lmParameters: resolved.lmParameters,
    systemPromptMessages: resolved.systemPromptMessages,
    autoTitleEnabled: resolved.autoTitleEnabled,
  };
}

function collectChatGroups({
  items,
}: {
  items: typeof rootItems.value,
}): ChatGroup[] {
  return items.flatMap((item) => {
    switch (item.type) {
    case 'chat':
      return [];
    case 'chat_group':
      return [item.chatGroup];
    default: {
      const _ex: never = item;
      throw new Error(`Unhandled sidebar item type: ${_ex}`);
    }
    }
  });
}

async function confirmTemporaryAttachments(): Promise<boolean> {
  const { settings } = useSettings();
  if (settings.value.heavyContentAlertDismissed !== false) {
    return true;
  }

  return await useConfirm().showConfirm({
    title: await ensureStrings.chatGenerationFlow__attachments_cannot_be_saved(),
    message: await ensureStrings.chatGenerationFlow__local_storage_attachments_are_only_available_during_this_session(),
    confirmButtonText: await ensureStrings.chatGenerationFlow__continue_anyway(),
    cancelButtonText: await ensureStrings.chatGenerationFlow__cancel(),
  });
}

async function persistAttachment({
  attachment,
}: {
  attachment: Attachment,
}): Promise<Attachment> {
  switch (attachment.status) {
  case 'memory':
    if (storageService.canPersistBinary) {
      try {
        await storageService.saveFile({ blob: attachment.blob, binaryObjectId: attachment.binaryObjectId, name: attachment.originalName });
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
}

function showOnboardingDraft({
  url,
  type,
  models,
}: {
  url: string | undefined,
  type: EndpointType,
  models: string[],
}): void {
  const settings = useSettings();
  settings.setOnboardingDraft?.({
    draft: { url: url || '', type, models, selectedModel: models[0] || '' },
  });
  settings.setIsOnboardingDismissed?.({ dismissed: false });
}

async function loadGenerationProvider({
  endpoint,
}: {
  endpoint: Endpoint,
}): Promise<LmProvider> {
  if (!isConfiguredEndpoint({ endpoint })) {
    throw new Error('Generation requires a supported configured endpoint.');
  }

  const { settings } = useSettings();
  return await loadLmProvider({
    endpoint,
    fakeLmDebugModeStatus: settings.value.experimental?.fakeLm ?? 'disabled',
  });
}

async function resolveAttachmentBlob({
  attachment,
}: {
  attachment: Attachment,
}): Promise<Blob | null> {
  switch (attachment.status) {
  case 'memory':
    return attachment.blob || null;
  case 'persisted':
    return await storageService.getFile({ binaryObjectId: attachment.binaryObjectId });
  case 'missing':
    return null;
  default: {
    const _ex: never = attachment;
    throw new Error(`Unhandled attachment status: ${_ex}`);
  }
  }
}

async function getEnabledToolsForChat({
  chat,
}: {
  chat: Chat,
}): Promise<Tool[]> {
  const { settings } = useSettings();
  const { requestChoice } = useChoices();
  const toolConfigs = getEffectiveToolConfigsForChat({ chat });
  const enabledNames = lmToolNamesFromToolConfigs({ toolConfigs });
  const shellExecuteEnabled = enabledNames.includes('shell_execute');
  const weshToolConfig = findLastToolConfigByKey({ toolConfigs, key: 'builtin.wesh' });
  const chatTmpDirectory = shellExecuteEnabled && shouldIncludeWritableTmpMount({ storageType: settings.value.storageType })
    ? await ensureChatTmpDirectory({ chatId: chat.id })
    : undefined;
  const chatGroupMounts = chat.groupId
    ? (currentChatGroupRef.value?.id === chat.groupId
      ? currentChatGroupRef.value.mounts
      : (await storageService.loadChatGroup({ id: chat.groupId }))?.mounts)
    : undefined;

  return await getEnabledTools({
    enabledNames,
    settings: settings.value as unknown as Settings,
    chatGroupMounts,
    chatMounts: chat.mounts,
    chatId: chat.id,
    chatGroupId: chat.groupId ?? undefined,
    naidanSysfsAccessScope: weshToolConfig?.naidanSysfs.accessScope ?? 'none',
    tmpHandle: chatTmpDirectory?.handle,
    requestChoice,
  });
}

async function handleImageGenerationWithDefaults({
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
  chatId: ChatId,
  assistantId: MessageId,
  prompt: string,
  width: number,
  height: number,
  count: number,
  steps: number | undefined,
  seed: number | 'browser_random' | undefined,
  persistAs: ImageRequestParams['persistAs'],
  images: { blob: Blob }[],
  model: string | undefined,
  signal: AbortSignal | undefined,
}): Promise<void> {
  const targetChat = getLiveChatById({ chatId });
  if (targetChat === null) {
    return;
  }

  const resolved = resolveGenerationSettings({ chat: targetChat });
  if (resolved.endpoint.type !== 'ollama' || resolved.endpoint.url === '') {
    throw new Error('Image generation requires an Ollama endpoint URL');
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
    endpointUrl: resolved.endpoint.url,
    endpointHttpHeaders: resolved.endpoint.httpHeaders
      ? [...resolved.endpoint.httpHeaders]
      : undefined,
    storageType: useSettings().settings.value.storageType,
    signal,
    getLiveChat,
    updateChatContent: async ({ chatId: contentChatId, updater }) => {
      await updateChatContent({
        id: contentChatId,
        updater: ({ current }) => {
          if (current === null) {
            throw new Error('Chat content not found');
          }
          return updater({ current: current });
        },
      });
    },
    triggerChatRef: ({ chatId: changedChatId }) => notifyChatChanged({ chatId: changedChatId }),
    incTask: ({ chatId: taskChatId, type }) => {
      if (type === 'process') {
        chatRuntimeStore.startTask({ key: { kind: 'process', chatId: taskChatId } });
      }
    },
    decTask: ({ chatId: taskChatId, type }) => {
      if (type === 'process') {
        chatRuntimeStore.finishTask({ key: { kind: 'process', chatId: taskChatId } });
      }
    },
  });
}

async function persistToolContent({
  text,
  type,
  toolCallId,
}: {
  text: string,
  type: 'result' | 'error',
  toolCallId: ToolCallId,
}): Promise<PersistedToolContent> {
  const binaryThreshold = 100 * 1024;
  if (text.length > binaryThreshold) {
    const blob = new Blob([text], { type: 'text/plain' });
    const binaryId = generateId<BinaryObjectId>();
    await storageService.saveFile({ blob, binaryObjectId: binaryId, name: `tool_${type}_${idToRaw({ id: toolCallId })}.txt` });
    return { type: 'binary_object', id: binaryId };
  }

  return { type: 'text', text };
}

async function showGenerationFailedToast({
  chat,
}: {
  chat: Chat,
}): Promise<void> {
  if (currentChatRef.value !== null && toRaw(currentChatRef.value).id === chat.id) {
    return;
  }

  const chatTitle = chat.title || await ensureStrings.SHARED__new_chat();
  useToast().addToast({
    message: await ensureStrings.chatGenerationFlow__generation_failed_in_chat({ chatTitle }),
    actionLabel: await ensureStrings.chatGenerationFlow__view(),
    onAction: async () => {
      await useChatNavigation().openChat({ chatId: chat.id, leafId: undefined });
    },
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  resolveGenerationModel,
};
