import { generateId } from '@/utils/id';
import type {
  Chat,
  ChatContent,
  ChatMessage,
  EndpointType,
  MessageNode,
} from '@/models/types';
import { storageService } from '@/services/storage';
import type { LLMProvider } from '@/services/lm/types';
import { OpenAIProvider } from '@/services/lm/openai';
import { OllamaProvider } from '@/services/lm/ollama';
import { TransformersJsProvider } from '@/services/transformers-js/provider';
import {
  buildCompactRequestMessages,
  createCompactBranchFromResponse,
  createCompactConversationMessageContent,
  createCompactMultimodalContent,
  createCompactToolMessageContent,
  getHeaderCompactBoundary,
  splitCompactPath,
  type ContextCompactPromptMode,
} from '@/services/context-compact';
import { fileToDataUrl, getChatBranchIterator } from '@/utils/chat-tree';
import type { ContextCompactRuntime } from '@/composables/chat/global/context-compact-runtime';

export type CompactCurrentBranchResult =
  | {
      status: 'compacted';
      chatId: string;
      compactNodeId: string;
      currentLeafId: string;
    }
  | {
      status: 'skipped';
      reason:
        | 'no_current_chat'
        | 'already_processing'
        | 'not_enough_messages'
        | 'empty_prefix'
        | 'missing_model_or_endpoint'
        | 'empty_response';
    }
  | {
      status: 'aborted';
    };

type ResolvedCompactSettings = {
  endpointType: EndpointType;
  endpointUrl: string | undefined;
  endpointHttpHeaders: [string, string][] | undefined;
  modelId: string;
  lmParameters: Chat['lmParameters'];
};

export type ContextCompactService = {
  abortContextCompact({
    chatId,
  }: {
    chatId: string | undefined;
  }): void;

  compactCurrentBranchForChat({
    chatId,
    keepRecentMessages,
    instructionOverride,
  }: {
    chatId: string;
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }): Promise<CompactCurrentBranchResult>;

  compactCurrentBranch({
    keepRecentMessages,
    instructionOverride,
  }: {
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }): Promise<CompactCurrentBranchResult>;
};

export function createContextCompactService({
  getCurrentChat,
  getChatTarget,
  getLiveChat,
  isProcessing,
  registerLiveInstance,
  resolveSettings,
  getPromptMode,
  runtime,
  updateChatContent,
  updateChatMeta,
  triggerCurrentChat,
  addErrorEvent,
  startProcessing,
  finishProcessing,
}: {
  getCurrentChat?: () => Chat | null;
  getChatTarget: ({ chatId }: { chatId: string | undefined }) => Chat | null;
  getLiveChat: ({ chat }: { chat: Chat }) => Chat;
  isProcessing: ({ chatId }: { chatId: string }) => boolean;
  registerLiveInstance: ({ chat }: { chat: Chat }) => void;
  resolveSettings: ({ chat }: { chat: Chat }) => ResolvedCompactSettings;
  getPromptMode: ({ chatId }: { chatId: string }) => ContextCompactPromptMode;
  runtime: ContextCompactRuntime;
  updateChatContent: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: ChatContent | null) => ChatContent | Promise<ChatContent>;
  }) => Promise<void>;
  updateChatMeta: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: Chat | null) => Chat | Promise<Chat>;
  }) => Promise<void>;
  triggerCurrentChat: ({ chatId }: { chatId: string }) => void;
  addErrorEvent: ({ source, message }: { source: string; message: string }) => void;
  startProcessing: ({ chatId }: { chatId: string }) => void;
  finishProcessing: ({ chatId }: { chatId: string }) => void;
}): ContextCompactService {
  function abortContextCompact({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return;
    }

    runtime.getActiveContextCompaction({ chatId })?.abort();
  }

  async function compactCurrentBranch({
    keepRecentMessages,
    instructionOverride,
  }: {
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }): Promise<CompactCurrentBranchResult> {
    const currentChat = getCurrentChat?.();
    if (!currentChat) {
      return { status: 'skipped', reason: 'no_current_chat' };
    }

    return compactCurrentBranchForChat({
      chatId: currentChat.id,
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
  }): Promise<CompactCurrentBranchResult> {
    const targetChat = getChatTarget({ chatId });
    if (!targetChat) {
      return { status: 'skipped', reason: 'no_current_chat' };
    }

    const mutableChat = getLiveChat({ chat: targetChat });
    if (isProcessing({ chatId: mutableChat.id })) {
      return { status: 'skipped', reason: 'already_processing' };
    }

    const path = Array.from(getChatBranchIterator({ chat: mutableChat }));
    const boundaryMessageId = getHeaderCompactBoundary({
      path,
      keepRecentMessages,
    });
    if (boundaryMessageId === undefined) {
      return { status: 'skipped', reason: 'not_enough_messages' };
    }

    const split = splitCompactPath({
      path,
      boundaryMessageId,
    });
    if (split === undefined || split.prefix.length === 0) {
      return { status: 'skipped', reason: 'empty_prefix' };
    }

    const controller = new AbortController();
    runtime.setActiveContextCompaction({
      chatId: mutableChat.id,
      controller,
    });
    startProcessing({ chatId: mutableChat.id });
    registerLiveInstance({ chat: mutableChat });
    runtime.setProgress({
      chatId: mutableChat.id,
      progress: {
        phase: 'preparing',
        compactedMessageCount: split.prefix.length,
        suffixMessageCount: split.suffix.length,
      },
    });

    try {
      const resolved = resolveSettings({ chat: mutableChat });
      const resolvedModel = mutableChat.modelId || resolved.modelId;

      if (!resolvedModel || (!resolved.endpointUrl && resolved.endpointType !== 'transformers_js')) {
        addErrorEvent({
          source: 'useChat:compactCurrentBranch',
          message: 'Compact Context requires a configured model and endpoint.',
        });
        runtime.setProgress({
          chatId: mutableChat.id,
          progress: {
            phase: 'failed',
            message: 'Compact Context requires a configured model and endpoint.',
          },
        });
        return { status: 'skipped', reason: 'missing_model_or_endpoint' };
      }

      const promptMode = getPromptMode({ chatId: mutableChat.id });
      runtime.setProgress({
        chatId: mutableChat.id,
        progress: {
          phase: 'building_request',
          compactedMessageCount: split.prefix.length,
          suffixMessageCount: split.suffix.length,
          requestPreview: undefined,
        },
      });

      const prefixMessages = await createCompactChatMessagesFromPrefix({
        prefix: split.prefix,
        promptMode,
      });
      const requestMessages = buildCompactRequestMessages({
        prefix: prefixMessages,
        promptMode,
        instructionContent: instructionOverride,
      });
      const requestPreview = createCompactRequestPreview({
        messages: requestMessages,
      });
      const provider = await createProviderForCompact({
        endpointType: resolved.endpointType,
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders,
      });

      let compactContent = '';
      runtime.setProgress({
        chatId: mutableChat.id,
        progress: {
          phase: 'requesting_model',
          compactedMessageCount: split.prefix.length,
          suffixMessageCount: split.suffix.length,
          requestPreview,
        },
      });

      await provider.chat({
        messages: requestMessages,
        model: resolvedModel,
        onChunk: (chunk) => {
          compactContent += chunk;
          runtime.setProgress({
            chatId: mutableChat.id,
            progress: {
              phase: 'receiving_compact',
              compactedMessageCount: split.prefix.length,
              suffixMessageCount: split.suffix.length,
              outputChars: compactContent.length,
              requestPreview,
              outputPreview: compactContent,
            },
          });
        },
        parameters: resolved.lmParameters,
        signal: controller.signal,
      });

      const finalCompactContent = compactContent.trim();
      if (finalCompactContent.length === 0) {
        runtime.setProgress({
          chatId: mutableChat.id,
          progress: {
            phase: 'failed',
            message: 'Compact Context response was empty.',
          },
        });
        return { status: 'skipped', reason: 'empty_response' };
      }

      runtime.setProgress({
        chatId: mutableChat.id,
        progress: {
          phase: 'applying_branch',
          outputChars: finalCompactContent.length,
          requestPreview,
          outputPreview: finalCompactContent,
        },
      });

      const branchResult = createCompactBranchFromResponse({
        compactContent: finalCompactContent,
        suffix: split.suffix,
        compactModelId: resolvedModel,
        createMessageId: () => generateId(),
        now: () => Date.now(),
      });

      mutableChat.root.items.push(branchResult.compactNode);
      mutableChat.currentLeafId = branchResult.currentLeafId;
      mutableChat.updatedAt = Date.now();

      await updateChatContent({
        id: mutableChat.id,
        updater: (current) => ({
          ...current,
          root: mutableChat.root,
          currentLeafId: mutableChat.currentLeafId,
        }),
      });
      await updateChatMeta({
        id: mutableChat.id,
        updater: (current) => {
          if (!current) {
            return mutableChat;
          }
          return {
            ...current,
            updatedAt: mutableChat.updatedAt,
            currentLeafId: mutableChat.currentLeafId,
          };
        },
      });
      triggerCurrentChat({ chatId: mutableChat.id });

      runtime.setProgress({
        chatId: mutableChat.id,
        progress: {
          phase: 'complete',
          requestPreview,
          outputPreview: finalCompactContent,
        },
      });

      return {
        status: 'compacted',
        chatId: mutableChat.id,
        compactNodeId: branchResult.compactNode.id,
        currentLeafId: branchResult.currentLeafId,
      };
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Generation aborted')) {
        runtime.setProgress({
          chatId: mutableChat.id,
          progress: { phase: 'aborted' },
        });
        return { status: 'aborted' };
      }

      runtime.setProgress({
        chatId: mutableChat.id,
        progress: {
          phase: 'failed',
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    } finally {
      runtime.clearActiveContextCompaction({
        chatId: mutableChat.id,
        controller,
      });
      finishProcessing({ chatId: mutableChat.id });
    }
  }

  return {
    abortContextCompact,
    compactCurrentBranchForChat,
    compactCurrentBranch,
  };
}

export async function createProviderForCompact({
  endpointType,
  endpointUrl,
  endpointHttpHeaders,
}: {
  endpointType: EndpointType;
  endpointUrl: string | undefined;
  endpointHttpHeaders: [string, string][] | undefined;
}): Promise<LLMProvider> {
  switch (endpointType) {
  case 'openai':
    if (!endpointUrl) {
      throw new Error('OpenAI compact provider requires an endpoint URL.');
    }
    return new OpenAIProvider({ endpoint: endpointUrl, headers: endpointHttpHeaders });
  case 'ollama':
    if (!endpointUrl) {
      throw new Error('Ollama compact provider requires an endpoint URL.');
    }
    return new OllamaProvider({ endpoint: endpointUrl, headers: endpointHttpHeaders });
  case 'transformers_js':
    return new TransformersJsProvider();
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unsupported endpoint type: ${_ex}`);
  }
  }
}

export async function createCompactChatMessagesFromPrefix({
  prefix,
  promptMode,
}: {
  prefix: readonly MessageNode[];
  promptMode: ContextCompactPromptMode;
}): Promise<ChatMessage[]> {
  const result: ChatMessage[] = [];

  for (const node of prefix) {
    switch (node.role) {
    case 'tool': {
      for (const toolResult of node.results) {
        let toolContent = '';
        const resultStatus = toolResult.status;
        switch (resultStatus) {
        case 'success': {
          const contentType = toolResult.content.type;
          switch (contentType) {
          case 'text':
            toolContent = toolResult.content.text;
            break;
          case 'binary_object': {
            const blob = await storageService.getFile({ binaryObjectId: toolResult.content.id });
            toolContent = blob ? await blob.text() : '[Error: Binary object missing]';
            break;
          }
          default: {
            const _ex: never = contentType;
            throw new Error(`Unhandled tool success content type: ${_ex}`);
          }
          }
          break;
        }
        case 'error': {
          const messageType = toolResult.error.message.type;
          switch (messageType) {
          case 'text':
            toolContent = `Error [${toolResult.error.code}]: ${toolResult.error.message.text}`;
            break;
          case 'binary_object': {
            const blob = await storageService.getFile({ binaryObjectId: toolResult.error.message.id });
            const detail = blob ? await blob.text() : 'Binary error detail missing';
            toolContent = `Error [${toolResult.error.code}]: ${detail}`;
            break;
          }
          default: {
            const _ex: never = messageType;
            throw new Error(`Unhandled tool error content type: ${_ex}`);
          }
          }
          break;
        }
        case 'executing':
          toolContent = '[Error: Tool still executing]';
          break;
        default: {
          const _ex: never = resultStatus;
          throw new Error(`Unhandled tool result status: ${_ex}`);
        }
        }

        result.push({
          role: 'tool',
          tool_call_id: toolResult.toolCallId,
          content: createCompactToolMessageContent({
            messageId: node.id,
            content: toolContent,
            promptMode,
          }),
        });
      }
      break;
    }
    case 'user': {
      const baseContent = createCompactConversationMessageContent({
        node,
        promptMode,
      });
      if (!node.attachments || node.attachments.length === 0) {
        result.push({ role: 'user', content: baseContent });
        break;
      }

      const images: string[] = [];
      for (const attachment of node.attachments) {
        let blob: Blob | null = null;
        switch (attachment.status) {
        case 'memory':
          blob = attachment.blob;
          break;
        case 'persisted':
          blob = await storageService.getFile({ binaryObjectId: attachment.binaryObjectId });
          break;
        case 'missing':
          blob = null;
          break;
        default: {
          const _ex: never = attachment;
          throw new Error(`Unhandled attachment status while compacting: ${_ex}`);
        }
        }

        if (blob && attachment.mimeType.startsWith('image/')) {
          images.push(await fileToDataUrl({ blob }));
        }
      }

      result.push({
        role: 'user',
        content: createCompactMultimodalContent({
          text: baseContent,
          images,
        }),
      });
      break;
    }
    case 'assistant':
      result.push({
        role: 'assistant',
        content: createCompactConversationMessageContent({
          node,
          promptMode,
        }),
        tool_calls: node.toolCalls,
      });
      break;
    case 'system':
      result.push({
        role: 'system',
        content: createCompactConversationMessageContent({
          node,
          promptMode,
        }),
      });
      break;
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled compact prefix node role: ${_ex}`);
    }
    }
  }

  return result;
}

export function createCompactRequestPreview({
  messages,
}: {
  messages: readonly ChatMessage[];
}): string {
  return messages.map((message) => {
    const content = (() => {
      if (typeof message.content === 'string') {
        return message.content;
      }

      return message.content.map((part) => {
        const partType = part.type;
        switch (partType) {
        case 'text':
          return part.text;
        case 'image_url':
          return '[image attachment]';
        default: {
          const _ex: never = partType;
          throw new Error(`Unhandled compact preview part: ${_ex}`);
        }
        }
      }).join('\n');
    })();

    return `[${message.role}]\n${content}`;
  }).join('\n\n');
}
