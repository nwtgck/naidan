import { reactive, toRaw } from 'vue';
import { ensureStrings } from '@/strings';
import type { AssistantMessageNode, Attachment, Chat, ChatGroup, ChatMessage, Endpoint, EndpointType, LmParameters, MessageNode, MultimodalContent, Settings, ToolMessageNode, UserMessageNode } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { isHttpEndpoint } from '@/01-models/endpoint';
import type { LmProvider } from '@/01-models/lm';
import type { Tool } from '@/01-models/tool';
import { createLmProvider } from '@/features/lm/providerFactory';
import { storageService } from '@/00-storage/service';
import { getEnabledTools } from '@/features/tools/factory';
import { markExecutingToolResultsAsInterrupted } from '@/features/tools/interruption';
import { findLastToolConfigByKey, lmToolNamesFromToolConfigs } from '@/features/tools/tool-config';
import { getEffectiveToolConfigsForChat } from '@/features/tools/composables/useChatTools';
import { shouldIncludeWritableTmpMount } from '@/features/wesh/mount-policy';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';
import {
  fileToDataUrl,
  findNodeInBranch,
  findParentInBranch,
  getAllMessages,
  getChatBranchIterator,
  processThinking,
} from '@/utils/chat-tree';
import { generateId } from '@/01-models/id';
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
    const { hasReachableEndpoint, url, type } = (() => {
      switch (endpoint.type) {
      case 'openai':
      case 'ollama':
        return {
          hasReachableEndpoint: endpoint.url !== '',
          url: endpoint.url,
          type: endpoint.type,
        };
      case 'transformers_js':
        return {
          hasReachableEndpoint: true,
          url: undefined,
          type: endpoint.type,
        };
      default: {
        const _ex: never = endpoint;
        throw new Error(`Unhandled endpoint: ${String(_ex)}`);
      }
      }
    })();
    let resolvedModel = mutableChat.modelId || resolved.modelId;

    if (hasReachableEndpoint) {
      const models = await fetchAvailableModelsForChat({
        chatId: mutableChat.id,
        errorSource: 'chat-generation-flow:resolve-models',
      });
      if (models.length > 0) {
        const preferredModel = mutableChat.modelId || resolved.modelId;
        if (preferredModel && models.includes(preferredModel)) {
          resolvedModel = preferredModel;
        } else if (preferredModel) {
          resolvedModel = models[0] || '';
        }
      }
    }

    if (!hasReachableEndpoint || !resolvedModel) {
      showOnboardingDraft({
        url,
        type,
        models: await fetchAvailableModelsForChat({
          chatId: mutableChat.id,
          errorSource: 'chat-generation-flow:show-onboarding',
        }),
      });
      return false;
    }

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
      id: generateId<MessageId>(),
      role: 'user',
      content: finalContent,
      attachments: processedAttachments.length > 0 ? processedAttachments : undefined,
      timestamp: Date.now(),
      replies: { items: [] },
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: lmParameters || EMPTY_LM_PARAMETERS,
      toolCalls: undefined,
      results: undefined,
    };

    const assistantMessage: AssistantMessageNode = {
      id: generateId<MessageId>(),
      role: 'assistant',
      content: imageModeEnabled
        ? createImageResponseMarker({ count }) + SENTINEL_IMAGE_PENDING
        : '',
      timestamp: Date.now(),
      modelId: imageModel || resolvedModel,
      replies: { items: [] },
      attachments: undefined,
      thinking: undefined,
      error: undefined,
      lmParameters: lmParameters || EMPTY_LM_PARAMETERS,
      toolCalls: undefined,
      results: undefined,
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
      lmParameters,
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
  const assistantNode = findNodeInBranch({ items: mutableChat.root.items, targetId: assistantId });
  if (assistantNode === null || assistantNode.role !== 'assistant') {
    throw new Error('Assistant node not found');
  }

  assistantNode.error = undefined;
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

  const resolved = resolveGenerationSettings({ chat: mutableChat });
  const resolvedModel = assistantNode.modelId || resolved.modelId;
  const finalLmParameters = lmParameters || resolved.lmParameters;

  assistantNode.lmParameters = finalLmParameters;
  assistantNode.modelId = resolvedModel;

  const parentNode = findParentInBranch({ items: mutableChat.root.items, childId: assistantId });
  const imageRequest = parentNode ? parseImageRequest({ content: parentNode.content || '' }) : null;
  const currentGenerationToolCallIds = new Set<ToolCallId>();

  try {
    if (imageRequest) {
      const { width = 512, height = 512, model, count = 1, persistAs, steps, seed } = imageRequest;
      const prompt = stripNaidanSentinels({ content: parentNode?.content || '' }).trim();

      const images: { blob: Blob }[] = [];
      if (parentNode?.attachments) {
        for (const attachment of parentNode.attachments) {
          const blob = await resolveAttachmentBlob({ attachment });
          if (blob !== null && attachment.mimeType.startsWith('image/')) {
            images.push({ blob });
          }
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

    const provider = createGenerationProvider({
      endpoint: resolved.endpoint,
    });
    const finalMessages = await buildGenerationMessages({
      chat: mutableChat,
      assistantId,
      systemPromptMessages: resolved.systemPromptMessages,
    });

    let lastSave = 0;
    let isSaving = false;
    const enabledTools = await getEnabledToolsForChat({ chat: mutableChat });
    const generationState = {
      currentAssistantNode: assistantNode,
      currentLeafNode: assistantNode as MessageNode,
      currentToolNode: null as ToolMessageNode | null,
    };

    try {
      signalReady();
      const { ensureApproval } = useApproval();
      await provider.chat({
        messages: finalMessages,
        model: resolvedModel,
        tools: enabledTools.length > 0 ? enabledTools : undefined,
        toolApprovalContext: {
          chatId: mutableChat.id,
          ensureApproval,
        },
        onAssistantMessageStart: () => {
          generationState.currentToolNode = null;

          if (generationState.currentAssistantNode.content !== '' || (generationState.currentAssistantNode.toolCalls?.length ?? 0) > 0) {
            const newNode: AssistantMessageNode = reactive({
              id: generateId<MessageId>(),
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              modelId: generationState.currentAssistantNode.modelId,
              replies: { items: [] },
              attachments: undefined,
              thinking: undefined,
              error: undefined,
              lmParameters: generationState.currentAssistantNode.lmParameters,
              toolCalls: undefined,
              results: undefined,
            });

            generationState.currentLeafNode.replies.items.push(newNode);
            mutableChat.currentLeafId = newNode.id;
            generationState.currentAssistantNode = newNode;
            generationState.currentLeafNode = newNode;
            notifyChatChanged({ chatId: mutableChat.id });
          }
        },
        onToolCall: ({ id, toolName, args }) => {
          currentGenerationToolCallIds.add(id);
          if (generationState.currentToolNode === null) {
            const toolNode: ToolMessageNode = reactive({
              id: generateId<MessageId>(),
              role: 'tool',
              results: [],
              content: undefined,
              timestamp: Date.now(),
              replies: { items: [] },
              attachments: undefined,
              thinking: undefined,
              error: undefined,
              modelId: undefined,
              lmParameters: undefined,
              toolCalls: undefined,
            });

            generationState.currentLeafNode.replies.items.push(toolNode);
            mutableChat.currentLeafId = toolNode.id;
            generationState.currentLeafNode = toolNode;
            generationState.currentToolNode = toolNode;
          }

          if (!generationState.currentToolNode.results.some((result) => result.toolCallId === id)) {
            generationState.currentToolNode.results.push({
              toolCallId: id,
              status: 'executing',
            });
          }
          chatVolatileState.setVolatileToolOutput({ toolCallId: id, output: '' });

          const assistantCalls = generationState.currentAssistantNode.toolCalls || [];
          if (!assistantCalls.some((toolCall) => toolCall.id === id)) {
            generationState.currentAssistantNode.toolCalls = [
              ...assistantCalls,
              {
                id,
                type: 'function',
                function: {
                  name: toolName,
                  arguments: typeof args === 'string' ? args : JSON.stringify(args),
                },
              },
            ];
          }

          notifyChatChanged({ chatId: mutableChat.id });
        },
        onToolEvent: ({ id, event }) => {
          switch (event.type) {
          case 'started':
            chatVolatileState.setVolatileToolOutput({ toolCallId: id, output: '' });
            break;
          case 'output':
            chatVolatileState.appendVolatileToolOutput({ toolCallId: id, text: event.text });
            break;
          case 'exit':
            break;
          default: {
            const _ex: never = event;
            console.error(`Unhandled tool event: ${_ex}`);
          }
          }
          notifyChatChanged({ chatId: mutableChat.id });
        },
        onToolResult: async ({ id, result }) => {
          const allMessages = getAllMessages({ chat: mutableChat });
          const toolNode = allMessages.find(
            (node) => node.role === 'tool' && node.results.some((entry) => entry.toolCallId === id),
          ) as ToolMessageNode | undefined;

          if (toolNode !== undefined) {
            const index = toolNode.results.findIndex((entry) => entry.toolCallId === id);
            if (index !== -1) {
              switch (result.status) {
              case 'success':
                toolNode.results[index] = {
                  toolCallId: id,
                  status: 'success',
                  content: await persistToolContent({ text: result.content, type: 'result', toolCallId: id }),
                };
                break;
              case 'error':
                toolNode.results[index] = {
                  toolCallId: id,
                  status: 'error',
                  error: {
                    code: result.code,
                    message: await persistToolContent({ text: result.message, type: 'error', toolCallId: id }),
                  },
                };
                break;
              default: {
                const _ex: never = result;
                console.error(`Unhandled tool result status: ${_ex}`);
              }
              }
            }
            notifyChatChanged({ chatId: mutableChat.id });
          }

          chatVolatileState.deleteVolatileToolOutput({ toolCallId: id });
          currentGenerationToolCallIds.delete(id);
        },
        onChunk: async ({ chunk }) => {
          generationState.currentAssistantNode.content += chunk;
          notifyChatChanged({ chatId: mutableChat.id });

          const now = Date.now();
          if (now - lastSave > 500 && !isSaving) {
            isSaving = true;
            try {
              await updateChatContent({
                id: mutableChat.id,

                updater: ({ current }) => ({
                  ...(current || {}),
                  root: mutableChat.root,
                  currentLeafId: mutableChat.currentLeafId,
                }),
              });
              lastSave = Date.now();
            } finally {
              isSaving = false;
            }
          }
        },
        parameters: finalLmParameters,
        signal: controller.signal,
      });
    } finally {
      await Promise.all(enabledTools.map(async (tool) => {
        await tool.dispose?.();
      }));
    }

    await updateChatContent({
      id: mutableChat.id,

      updater: ({ current }) => ({
        ...(current || {}),
        root: mutableChat.root,
        currentLeafId: mutableChat.currentLeafId,
      }),
    });
    processThinking({ node: assistantNode });
    mutableChat.updatedAt = Date.now();

    if (mutableChat.title === null && resolved.autoTitleEnabled && chatRuntimeStore.activeGenerations.has(mutableChat.id)) {
      await generateChatTitleForChat({
        chatId: mutableChat.id,
        signal: controller.signal,
        titleModelIdOverride: undefined,
      });
    }
  } catch (error) {
    signalReady();
    let interruptedToolCount = 0;
    for (const message of getAllMessages({ chat: mutableChat })) {
      switch (message.role) {
      case 'tool':
        interruptedToolCount += markExecutingToolResultsAsInterrupted({
          results: message.results,
          toolCallIds: currentGenerationToolCallIds,
        });
        break;
      case 'user':
      case 'assistant':
      case 'system':
        break;
      default: {
        const _ex: never = message;
        throw new Error(`Unhandled message role: ${((_ex satisfies never) as { readonly role: string }).role}`);
      }
      }
    }
    for (const toolCallId of currentGenerationToolCallIds) {
      chatVolatileState.deleteVolatileToolOutput({ toolCallId });
    }
    currentGenerationToolCallIds.clear();

    if (interruptedToolCount > 0) {
      notifyChatChanged({ chatId: mutableChat.id });
    }

    const lastOpen = assistantNode.content.lastIndexOf('<think>');
    const lastClose = assistantNode.content.lastIndexOf('</think>');
    if (lastOpen > -1 && lastClose < lastOpen) {
      assistantNode.content += '</think>';
    }
    processThinking({ node: assistantNode });

    if ((error as Error).name === 'AbortError' || (error as Error).message === 'Generation aborted') {
      assistantNode.content += '\n\n[Generation Aborted]';
      notifyChatChanged({ chatId: mutableChat.id });
      await updateChatContent({
        id: mutableChat.id,

        updater: ({ current }) => ({
          ...(current || {}),
          root: mutableChat.root,
          currentLeafId: mutableChat.currentLeafId,
        }),
      });
    } else {
      assistantNode.error = (error as Error).message;
      chatVolatileState.setVolatileAssistantError({
        chatId: mutableChat.id,
        messageId: assistantNode.id,
        error: assistantNode.error,
      });
      console.error('[useChat] Generation failed:', {
        chatId: mutableChat.id,
        assistantId: assistantNode.id,
        error: assistantNode.error,
      });
      notifyChatChanged({ chatId: mutableChat.id });
      await updateChatContent({
        id: mutableChat.id,

        updater: ({ current }) => ({
          ...(current || {}),
          root: mutableChat.root,
          currentLeafId: mutableChat.currentLeafId,
        }),
      });
      await showGenerationFailedToast({ chat: mutableChat });
    }
  } finally {
    signalReady();
    if (chatRuntimeStore.activeGenerations.has(mutableChat.id)) {
      chatRuntimeStore.deleteActiveGeneration({ chatId: mutableChat.id });
      storageService.notify({
        event: {
          type: 'chat_content_generation',
          id: idToRaw({ id: mutableChat.id }),
          status: 'stopped',
          timestamp: Date.now(),
        },
      });
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
    if (parent === null || parent.role !== 'user') {
      return;
    }

    const newAssistantMessage: AssistantMessageNode = {
      id: generateId<MessageId>(),
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

function createGenerationProvider({
  endpoint,
}: {
  endpoint: Endpoint,
}): LmProvider {
  if (isHttpEndpoint(endpoint) && endpoint.url === '') {
    throw new Error(`${endpoint.type} generation requires an endpoint URL`);
  }

  const { settings } = useSettings();
  return createLmProvider({
    endpoint,
    fakeLmDebugModeStatus: settings.value.experimental?.fakeLm ?? 'disabled',
  });
}

async function buildGenerationMessages({
  chat,
  assistantId,
  systemPromptMessages,
}: {
  chat: Chat,
  assistantId: MessageId,
  systemPromptMessages: string[],
}): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  systemPromptMessages.forEach((content) => {
    messages.push({ role: 'system', content });
  });

  const history = Array.from(getChatBranchIterator({ chat })).filter((message) => message.id !== assistantId);
  for (const message of history) {
    switch (message.role) {
    case 'tool':
      for (const result of message.results) {
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: await getToolResultText({ result }),
        });
      }
      break;
    case 'user':
    case 'assistant':
    case 'system': {
      const content = message.content || '';
      if (message.role === 'user' && message.attachments && message.attachments.length > 0) {
        const contentParts: MultimodalContent[] = [{ type: 'text', text: content }];
        for (const attachment of message.attachments) {
          const blob = await resolveAttachmentBlob({ attachment });
          if (blob !== null && attachment.mimeType.startsWith('image/')) {
            const dataUrl = await fileToDataUrl({ blob });
            contentParts.push({ type: 'image_url', image_url: { url: dataUrl } });
          }
        }
        messages.push({ role: message.role, content: contentParts });
      } else {
        const toolCalls = (() => {
          switch (message.role) {
          case 'assistant':
            return message.toolCalls;
          case 'user':
          case 'system':
            return undefined;
          default: {
            const _ex: never = message;
            throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
          }
          }
        })();
        messages.push({
          role: message.role,
          content,
          tool_calls: toolCalls,
        });
      }
      break;
    }
    default: {
      const _ex: never = message;
      throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
    }
    }
  }

  return messages;
}

async function getToolResultText({
  result,
}: {
  result: ToolMessageNode['results'][number],
}): Promise<string> {
  switch (result.status) {
  case 'success':
    switch (result.content.type) {
    case 'text':
      return result.content.text;
    case 'binary_object': {
      const blob = await storageService.getFile({ binaryObjectId: result.content.id });
      return blob ? await blob.text() : '[Error: Binary object missing]';
    }
    default: {
      const _ex: never = result.content;
      return `[Error: Unknown content type: ${_ex}]`;
    }
    }
  case 'error':
    switch (result.error.message.type) {
    case 'text':
      return `Error [${result.error.code}]: ${result.error.message.text}`;
    case 'binary_object': {
      const blob = await storageService.getFile({ binaryObjectId: result.error.message.id });
      const detail = blob ? await blob.text() : 'Binary error detail missing';
      return `Error [${result.error.code}]: ${detail}`;
    }
    default: {
      const _ex: never = result.error.message;
      return `[Error: Unknown error message type: ${_ex}]`;
    }
    }
  case 'executing':
    return '[Error: Tool still executing]';
  default: {
    const _ex: never = result;
    return `[Error: Unknown tool status: ${_ex}]`;
  }
  }
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
