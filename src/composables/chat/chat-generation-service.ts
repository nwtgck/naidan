import { reactive } from 'vue';
import { generateId } from '@/utils/id';
import { OpenAIProvider } from '@/services/lm/openai';
import { OllamaProvider } from '@/services/lm/ollama';
import { TransformersJsProvider } from '@/services/transformers-js/provider';
import type {
  AssistantMessageNode,
  Attachment,
  Chat,
  ChatContent,
  ChatMessage,
  EndpointType,
  LmParameters,
  MessageNode,
  MultimodalContent,
  ToolMessageNode,
  UserMessageNode,
} from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import type { LLMProvider } from '@/services/lm/types';
import type { Tool } from '@/services/tools/types';
import { fileToDataUrl, findNodeInBranch, findParentInBranch, getAllMessages, getChatBranchIterator, processThinking } from '@/utils/chat-tree';
import {
  SENTINEL_IMAGE_PENDING,
  createImageRequestMarker,
  createImageResponseMarker,
  isImageRequest,
  parseImageRequest,
  stripNaidanSentinels,
  type ImageRequestParams,
} from '@/utils/image-generation';

type ResolvedGenerationSettings = {
  endpointType: EndpointType;
  endpointUrl: string | undefined;
  endpointHttpHeaders: [string, string][] | undefined;
  modelId: string;
  lmParameters: LmParameters | undefined;
  systemPromptMessages: string[];
  autoTitleEnabled: boolean;
};

type PersistedToolContent =
  | { type: 'text'; text: string }
  | { type: 'binary_object'; id: string };

export type ChatGenerationService = {
  sendMessage({
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
  }): Promise<boolean>;

  generateResponse({
    chat,
    assistantId,
    lmParameters,
    onReady,
  }: {
    chat: Chat | Readonly<Chat>;
    assistantId: string;
    lmParameters?: LmParameters;
    onReady?: (_args: Record<never, never>) => void;
  }): Promise<void>;
};

export function createChatGenerationService({
  getCurrentChat,
  getLiveChat,
  registerLiveInstance,
  isProcessing,
  startProcessing,
  finishProcessing,
  triggerCurrentChat,
  resolveSettings,
  fetchAvailableModels,
  canPersistBinary,
  persistAttachment,
  confirmTemporaryAttachments,
  dismissHeavyContentAlert,
  showOnboardingDraft,
  isImageMode,
  getSelectedImageModel,
  getResolution,
  getCount,
  getSteps,
  getSeed,
  getPersistAs,
  getAvailableModels,
  reportMissingImageModel,
  setActiveGeneration,
  deleteActiveGeneration,
  hasActiveGeneration,
  handleImageGeneration,
  loadBinaryObject,
  persistToolContent,
  updateChatContent,
  updateChatMeta,
  reloadAfterGenerationMetaUpdate,
  setVolatileAssistantError,
  clearVolatileAssistantError,
  setVolatileToolOutput,
  appendVolatileToolOutput,
  deleteVolatileToolOutput,
  notifyGenerationStatus,
  getEnabledToolsForChat,
  requestPersistence,
  showGenerationFailedToast,
  generateChatTitle,
  reorderSidebarChatAfterSend,
}: {
  getCurrentChat: () => Readonly<Chat> | null;
  getLiveChat: ({ chat }: { chat: Chat | Readonly<Chat> }) => Chat;
  registerLiveInstance: ({ chat }: { chat: Chat }) => void;
  isProcessing: ({ chatId }: { chatId: string }) => boolean;
  startProcessing: ({ chatId }: { chatId: string }) => void;
  finishProcessing: ({ chatId }: { chatId: string }) => void;
  triggerCurrentChat: ({ chatId }: { chatId: string }) => void;
  resolveSettings: ({ chat }: { chat: Chat }) => ResolvedGenerationSettings;
  fetchAvailableModels: ({
    chatId,
  }: {
    chatId: string;
  }) => Promise<string[]>;
  canPersistBinary: () => boolean;
  persistAttachment: ({ attachment }: { attachment: Attachment }) => Promise<Attachment>;
  confirmTemporaryAttachments: (_args: Record<never, never>) => Promise<boolean>;
  dismissHeavyContentAlert: (_args: Record<never, never>) => void;
  showOnboardingDraft: ({
    url,
    type,
    models,
  }: {
    url: string | undefined;
    type: EndpointType;
    models: string[];
  }) => void;
  isImageMode: ({ chatId }: { chatId: string }) => boolean;
  getSelectedImageModel: ({
    chatId,
    availableModels,
  }: {
    chatId: string;
    availableModels: string[];
  }) => string | undefined;
  getResolution: ({ chatId }: { chatId: string }) => { width: number; height: number };
  getCount: ({ chatId }: { chatId: string }) => number;
  getSteps: ({ chatId }: { chatId: string }) => number | undefined;
  getSeed: ({ chatId }: { chatId: string }) => number | 'browser_random' | undefined;
  getPersistAs: ({ chatId }: { chatId: string }) => ImageRequestParams['persistAs'];
  getAvailableModels: () => string[];
  reportMissingImageModel: (_args: Record<never, never>) => Promise<void>;
  setActiveGeneration: ({
    chatId,
    generation,
  }: {
    chatId: string;
    generation: { controller: AbortController; chat: Chat };
  }) => void;
  deleteActiveGeneration: ({ chatId }: { chatId: string }) => void;
  hasActiveGeneration: ({ chatId }: { chatId: string }) => boolean;
  handleImageGeneration: ({
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
    persistAs: 'original' | 'png' | 'jpeg' | 'webp' | undefined;
    images: { blob: Blob }[];
    model: string | undefined;
    signal: AbortSignal | undefined;
  }) => Promise<void>;
  loadBinaryObject: ({ id }: { id: string }) => Promise<Blob | null>;
  persistToolContent: ({
    text,
    type,
    toolCallId,
  }: {
    text: string;
    type: 'result' | 'error';
    toolCallId: string;
  }) => Promise<PersistedToolContent>;
  updateChatContent: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: ChatContent | null) => ChatContent;
  }) => Promise<void>;
  updateChatMeta: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: Chat | null) => Chat | Promise<Chat>;
  }) => Promise<void>;
  reloadAfterGenerationMetaUpdate: (_args: Record<never, never>) => Promise<void>;
  setVolatileAssistantError: ({
    chatId,
    messageId,
    error,
  }: {
    chatId: string;
    messageId: string;
    error: string;
  }) => void;
  clearVolatileAssistantError: ({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }) => void;
  setVolatileToolOutput: ({
    toolCallId,
    output,
  }: {
    toolCallId: string;
    output: string;
  }) => void;
  appendVolatileToolOutput: ({
    toolCallId,
    text,
  }: {
    toolCallId: string;
    text: string;
  }) => void;
  deleteVolatileToolOutput: ({ toolCallId }: { toolCallId: string }) => void;
  notifyGenerationStatus: ({
    chatId,
    status,
  }: {
    chatId: string;
    status: 'started' | 'stopped' | 'abort_request';
  }) => void;
  getEnabledToolsForChat: ({ chat }: { chat: Chat }) => Promise<Tool[]>;
  requestPersistence: (_args: Record<never, never>) => void;
  showGenerationFailedToast: ({ chat }: { chat: Chat }) => Promise<void>;
  generateChatTitle: ({
    chatId,
    signal,
    titleModelIdOverride,
  }: {
    chatId: string | undefined;
    signal: AbortSignal | undefined;
    titleModelIdOverride: string | undefined;
  }) => Promise<string | undefined>;
  reorderSidebarChatAfterSend: ({ chatId }: { chatId: string }) => Promise<void>;
}): ChatGenerationService {
  async function sendMessage({
    content,
    parentId = undefined,
    attachments = [],
    chatTarget = undefined,
    lmParameters = undefined,
  }: {
    content: string;
    parentId?: string | null;
    attachments?: Attachment[];
    chatTarget?: Chat | Readonly<Chat>;
    lmParameters?: LmParameters;
  }) {
    const target = chatTarget || getCurrentChat();
    if (!target) return false;
    if (isProcessing({ chatId: target.id })) return false;

    const chat = getLiveChat({ chat: target });
    startProcessing({ chatId: chat.id });
    registerLiveInstance({ chat });

    try {
      const resolved = resolveSettings({ chat });
      const type = resolved.endpointType;
      const url = resolved.endpointUrl;
      let resolvedModel = chat.modelId || resolved.modelId;

      if (url || type === 'transformers_js') {
        const models = await fetchAvailableModels({ chatId: chat.id });
        if (models.length > 0) {
          const preferredModel = chat.modelId || resolved.modelId;
          if (preferredModel && models.includes(preferredModel)) {
            resolvedModel = preferredModel;
          } else if (preferredModel) {
            resolvedModel = models[0] || '';
          }
        }
      }

      if ((!url && type !== 'transformers_js') || !resolvedModel) {
        const models = await fetchAvailableModels({ chatId: chat.id });
        showOnboardingDraft({
          url,
          type,
          models,
        });
        return false;
      }

      const processedAttachments: Attachment[] = [];
      if (attachments.length > 0 && !canPersistBinary()) {
        const confirmed = await confirmTemporaryAttachments({});
        if (!confirmed) return false;
        dismissHeavyContentAlert({});
      }

      for (const attachment of attachments) {
        processedAttachments.push(await persistAttachment({ attachment }));
      }

      const imageModeEnabled = isImageMode({ chatId: chat.id });
      const imageModel = imageModeEnabled
        ? getSelectedImageModel({ chatId: chat.id, availableModels: getAvailableModels() })
        : undefined;
      const resolution = getResolution({ chatId: chat.id });
      const count = getCount({ chatId: chat.id });
      const steps = getSteps({ chatId: chat.id });
      const seed = getSeed({ chatId: chat.id });
      const persistAs = getPersistAs({ chatId: chat.id });

      let finalContent = content;
      if (imageModeEnabled && !isImageRequest({ content })) {
        if (!imageModel) {
          await reportMissingImageModel({});
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
        id: generateId(),
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
        id: generateId(),
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

      if (!chat.root) {
        chat.root = { items: [] };
      }

      if (parentId === null) {
        chat.root.items.push(userMessage);
      } else {
        const candidateParentId = parentId || chat.currentLeafId;
        const parentNode = candidateParentId
          ? findNodeInBranch({ items: chat.root.items, targetId: candidateParentId })
          : null;
        if (parentNode) {
          parentNode.replies.items.push(userMessage);
        } else {
          chat.root.items.push(userMessage);
        }
      }

      chat.currentLeafId = assistantMessage.id;
      triggerCurrentChat({ chatId: chat.id });
      await updateChatContent({
        id: chat.id,
        updater: (current) => ({
          ...(current || {}),
          root: chat.root,
          currentLeafId: chat.currentLeafId,
        }),
      });
      await updateChatMeta({
        id: chat.id,
        updater: (current) => {
          if (!current) return chat;
          return { ...current, updatedAt: Date.now(), currentLeafId: chat.currentLeafId };
        },
      });
      await reorderSidebarChatAfterSend({ chatId: chat.id });
      let markGenerationReady: (() => void) | undefined;
      const generationReady = new Promise<void>(resolve => {
        markGenerationReady = resolve;
      });
      generateResponse({
        chat,
        assistantId: assistantMessage.id,
        lmParameters,
        onReady: (_args) => {
          markGenerationReady?.();
          markGenerationReady = undefined;
        },
      }).catch(error => {
        markGenerationReady?.();
        markGenerationReady = undefined;
        console.error('Background generation failed:', error);
      });
      await generationReady;
      return true;
    } finally {
      finishProcessing({ chatId: chat.id });
    }
  }

  async function generateResponse({
    chat,
    assistantId,
    lmParameters,
    onReady = undefined,
  }: {
    chat: Chat | Readonly<Chat>;
    assistantId: string;
    lmParameters?: LmParameters;
    onReady?: (_args: Record<never, never>) => void;
  }) {
    let didSignalReady = false;
    const signalReady = () => {
      if (didSignalReady) return;
      didSignalReady = true;
      onReady?.({});
    };

    const mutableChat = getLiveChat({ chat });
    const assistantNode = findNodeInBranch({ items: mutableChat.root.items, targetId: assistantId });
    if (!assistantNode) throw new Error('Assistant node not found');
    switch (assistantNode.role) {
    case 'assistant':
      break;
    case 'user':
    case 'system':
    case 'tool':
      throw new Error('Invalid role for generation target');
    default: {
      const _ex: never = assistantNode;
      throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
    }
    }

    assistantNode.error = undefined;
    clearVolatileAssistantError({ chatId: mutableChat.id, messageId: assistantNode.id });
    triggerCurrentChat({ chatId: mutableChat.id });

    const controller = new AbortController();
    setActiveGeneration({
      chatId: mutableChat.id,
      generation: { controller, chat: mutableChat },
    });
    notifyGenerationStatus({ chatId: mutableChat.id, status: 'started' });
    registerLiveInstance({ chat: mutableChat });

    const resolved = resolveSettings({ chat: mutableChat });
    const resolvedModel = assistantNode.modelId || resolved.modelId;
    const finalLmParameters = lmParameters || resolved.lmParameters;

    assistantNode.lmParameters = finalLmParameters;
    assistantNode.modelId = resolvedModel;

    const parentNode = findParentInBranch({ items: mutableChat.root.items, childId: assistantId });
    const imageRequest = parentNode ? parseImageRequest({ content: parentNode.content || '' }) : null;

    try {
      if (imageRequest) {
        const { width = 512, height = 512, model, count = 1, persistAs, steps, seed } = imageRequest;
        const prompt = stripNaidanSentinels({ content: parentNode?.content || '' }).trim();

        const images: { blob: Blob }[] = [];
        if (parentNode?.attachments) {
          for (const attachment of parentNode.attachments) {
            const blob = await resolveAttachmentBlob({ attachment, loadBinaryObject });
            if (blob && attachment.mimeType.startsWith('image/')) {
              images.push({ blob });
            }
          }
        }

        signalReady();
        await handleImageGeneration({
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
        endpointType: resolved.endpointType,
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders,
      });

      const finalMessages = await buildGenerationMessages({
        chat: mutableChat,
        assistantId,
        systemPromptMessages: resolved.systemPromptMessages,
        loadBinaryObject,
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
        await provider.chat({
          messages: finalMessages,
          model: resolvedModel,
          tools: enabledTools.length > 0 ? enabledTools : undefined,
          onAssistantMessageStart: () => {
            generationState.currentToolNode = null;

            if (generationState.currentAssistantNode.content !== '' || (generationState.currentAssistantNode.toolCalls?.length ?? 0) > 0) {
              const newNode: AssistantMessageNode = reactive({
                id: generateId(),
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
              triggerCurrentChat({ chatId: mutableChat.id });
            }
          },
          onToolCall: ({ id, toolName, args }) => {
            if (!generationState.currentToolNode) {
              const toolNode: ToolMessageNode = reactive({
                id: generateId(),
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

            if (!generationState.currentToolNode.results.some(result => result.toolCallId === id)) {
              generationState.currentToolNode.results.push({
                toolCallId: id,
                status: 'executing',
              });
            }
            setVolatileToolOutput({ toolCallId: id, output: '' });

            const assistantCalls = generationState.currentAssistantNode.toolCalls || [];
            if (!assistantCalls.some(toolCall => toolCall.id === id)) {
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

            triggerCurrentChat({ chatId: mutableChat.id });
          },
          onToolEvent: ({ id, event }) => {
            switch (event.type) {
            case 'started':
              setVolatileToolOutput({ toolCallId: id, output: '' });
              break;
            case 'output':
              appendVolatileToolOutput({ toolCallId: id, text: event.text });
              break;
            case 'exit':
              break;
            default: {
              const _ex: never = event;
              console.error(`Unhandled tool event: ${_ex}`);
            }
            }
            triggerCurrentChat({ chatId: mutableChat.id });
          },
          onToolResult: async ({ id, result }) => {
            const allMessages = getAllMessages({ chat: mutableChat });
            const toolNode = allMessages.find(node => node.role === 'tool' && node.results.some(entry => entry.toolCallId === id)) as ToolMessageNode | undefined;

            if (toolNode) {
              const index = toolNode.results.findIndex(entry => entry.toolCallId === id);
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
              triggerCurrentChat({ chatId: mutableChat.id });
            }
            deleteVolatileToolOutput({ toolCallId: id });
          },
          onChunk: async (chunk) => {
            generationState.currentAssistantNode.content += chunk;
            triggerCurrentChat({ chatId: mutableChat.id });

            const now = Date.now();
            if (now - lastSave > 500 && !isSaving) {
              isSaving = true;
              try {
                await updateChatContent({
                  id: mutableChat.id,
                  updater: (current) => ({
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
        await Promise.all(enabledTools.map(async tool => {
          await tool.dispose?.();
        }));
      }

      await updateChatContent({
        id: mutableChat.id,
        updater: (current) => ({
          ...(current || {}),
          root: mutableChat.root,
          currentLeafId: mutableChat.currentLeafId,
        }),
      });
      processThinking({ node: assistantNode });
      mutableChat.updatedAt = Date.now();

      if (mutableChat.title === null && resolved.autoTitleEnabled && hasActiveGeneration({ chatId: mutableChat.id })) {
        await generateChatTitle({
          chatId: mutableChat.id,
          signal: controller.signal,
          titleModelIdOverride: undefined,
        });
      }
    } catch (error) {
      signalReady();
      const lastOpen = assistantNode.content.lastIndexOf('<think>');
      const lastClose = assistantNode.content.lastIndexOf('</think>');
      if (lastOpen > -1 && lastClose < lastOpen) {
        assistantNode.content += '</think>';
      }
      processThinking({ node: assistantNode });

      if ((error as Error).name === 'AbortError' || (error as Error).message === 'Generation aborted') {
        assistantNode.content += '\n\n[Generation Aborted]';
        triggerCurrentChat({ chatId: mutableChat.id });
        await updateChatContent({
          id: mutableChat.id,
          updater: (current) => ({
            ...(current || {}),
            root: mutableChat.root,
            currentLeafId: mutableChat.currentLeafId,
          }),
        });
      } else {
        assistantNode.error = (error as Error).message;
        setVolatileAssistantError({
          chatId: mutableChat.id,
          messageId: assistantNode.id,
          error: assistantNode.error,
        });
        console.error('[useChat] Generation failed:', {
          chatId: mutableChat.id,
          assistantId: assistantNode.id,
          error: assistantNode.error,
        });
        triggerCurrentChat({ chatId: mutableChat.id });
        await updateChatContent({
          id: mutableChat.id,
          updater: (current) => ({
            ...(current || {}),
            root: mutableChat.root,
            currentLeafId: mutableChat.currentLeafId,
          }),
        });
        await showGenerationFailedToast({ chat: mutableChat });
      }
    } finally {
      signalReady();
      if (hasActiveGeneration({ chatId: mutableChat.id })) {
        deleteActiveGeneration({ chatId: mutableChat.id });
        notifyGenerationStatus({ chatId: mutableChat.id, status: 'stopped' });
        updateChatMeta({
          id: mutableChat.id,
          updater: (current) => {
            if (!current) return mutableChat;
            return { ...current, updatedAt: Date.now(), currentLeafId: mutableChat.currentLeafId };
          },
        }).then(async () => {
          await reloadAfterGenerationMetaUpdate({});
        }).catch(() => {});

        const history = Array.from(getChatBranchIterator({ chat: mutableChat }));
        const assistantMessages = history.filter(message => message.role === 'assistant');
        if (assistantMessages.length === 1) {
          requestPersistence({});
        }
      }
    }
  }

  return {
    sendMessage,
    generateResponse,
  };
}

function createGenerationProvider({
  endpointType,
  endpointUrl,
  endpointHttpHeaders,
}: {
  endpointType: EndpointType;
  endpointUrl: string | undefined;
  endpointHttpHeaders: [string, string][] | undefined;
}): LLMProvider {
  switch (endpointType) {
  case 'openai':
    if (!endpointUrl) throw new Error('OpenAI generation requires an endpoint URL');
    return new OpenAIProvider({ endpoint: endpointUrl, headers: endpointHttpHeaders });
  case 'ollama':
    if (!endpointUrl) throw new Error('Ollama generation requires an endpoint URL');
    return new OllamaProvider({ endpoint: endpointUrl, headers: endpointHttpHeaders });
  case 'transformers_js':
    return new TransformersJsProvider();
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unsupported endpoint type: ${_ex}`);
  }
  }
}

async function buildGenerationMessages({
  chat,
  assistantId,
  systemPromptMessages,
  loadBinaryObject,
}: {
  chat: Chat;
  assistantId: string;
  systemPromptMessages: string[];
  loadBinaryObject: ({ id }: { id: string }) => Promise<Blob | null>;
}): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  systemPromptMessages.forEach(content => {
    messages.push({ role: 'system', content });
  });

  const history = Array.from(getChatBranchIterator({ chat })).filter(message => message.id !== assistantId);
  for (const message of history) {
    switch (message.role) {
    case 'tool': {
      for (const result of message.results) {
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: await getToolResultText({ result, loadBinaryObject }),
        });
      }
      break;
    }
    case 'user':
    case 'assistant':
    case 'system': {
      const content = message.content || '';
      if (message.role === 'user' && message.attachments && message.attachments.length > 0) {
        const contentParts: MultimodalContent[] = [{ type: 'text', text: content }];
        for (const attachment of message.attachments) {
          const blob = await resolveAttachmentBlob({ attachment, loadBinaryObject });
          if (blob && attachment.mimeType.startsWith('image/')) {
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
  loadBinaryObject,
}: {
  result: ToolMessageNode['results'][number];
  loadBinaryObject: ({ id }: { id: string }) => Promise<Blob | null>;
}): Promise<string> {
  switch (result.status) {
  case 'success':
    switch (result.content.type) {
    case 'text':
      return result.content.text;
    case 'binary_object': {
      const blob = await loadBinaryObject({ id: result.content.id });
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
      const blob = await loadBinaryObject({ id: result.error.message.id });
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
  loadBinaryObject,
}: {
  attachment: Attachment;
  loadBinaryObject: ({ id }: { id: string }) => Promise<Blob | null>;
}): Promise<Blob | null> {
  switch (attachment.status) {
  case 'memory':
    return attachment.blob || null;
  case 'persisted':
    return await loadBinaryObject({ id: attachment.binaryObjectId });
  case 'missing':
    return null;
  default: {
    const _ex: never = attachment;
    throw new Error(`Unhandled attachment status: ${_ex}`);
  }
  }
}
