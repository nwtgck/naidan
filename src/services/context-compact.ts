import { generateId } from '@/utils/id';
import type {
  AssistantMessageNode,
  Attachment,
  ChatMessage,
  EndpointType,
  LmParameters,
  MessageNode,
  MultimodalContent,
  ToolCall,
} from '@/models/types';
import { storageService } from '@/services/storage';
import type { LLMProvider } from '@/services/lm/types';
import type { ToolExecutionResult } from '@/services/tools/types';
import { fileToDataUrl } from '@/utils/chat-tree';

export type ContextCompactProgress =
  | { phase: 'idle' }
  | {
      phase: 'preparing';
      compactedMessageCount: number;
      suffixMessageCount: number;
    }
  | {
      phase: 'building_request';
      compactedMessageCount: number;
      suffixMessageCount: number;
      requestPreview: string | undefined;
    }
  | {
      phase: 'requesting_model';
      compactedMessageCount: number;
      suffixMessageCount: number;
      requestPreview: string | undefined;
    }
  | {
      phase: 'receiving_compact';
      compactedMessageCount: number;
      suffixMessageCount: number;
      outputChars: number;
      requestPreview: string | undefined;
      outputPreview: string;
    }
  | {
      phase: 'applying_branch';
      outputChars: number;
      requestPreview: string | undefined;
      outputPreview: string;
    }
  | {
      phase: 'complete';
      requestPreview: string | undefined;
      outputPreview: string;
    }
  | { phase: 'failed'; message: string }
  | { phase: 'aborted' };

export type ContextCompactPromptMode =
  | 'with_message_ids'
  | 'without_message_ids';

export type ContextCompactSplit = {
  prefix: MessageNode[];
  suffix: MessageNode[];
  boundaryMessageId: string;
};

export type ContextCompactBranchResult = {
  compactNode: AssistantMessageNode;
  copiedSuffixHead: MessageNode | undefined;
  currentLeafId: string;
};

export type ChatPaneHeaderMoreAction =
  | 'print'
  | 'search_chat'
  | 'open_history'
  | 'compact_context'
  | 'export_chat'
  | 'toggle_media_shelf'
  | 'share_url'
  | 'open_file_explorer'
  | 'toggle_wesh_terminal'
  | 'toggle_debug';

export function getHeaderCompactBoundary({
  path,
  keepRecentMessages,
}: {
  path: readonly MessageNode[];
  keepRecentMessages: number;
}): string | undefined {
  if (path.length <= keepRecentMessages) {
    return undefined;
  }

  const boundaryIndex = path.length - keepRecentMessages - 1;
  return path[boundaryIndex]?.id;
}

export function splitCompactPath({
  path,
  boundaryMessageId,
}: {
  path: readonly MessageNode[];
  boundaryMessageId: string;
}): ContextCompactSplit | undefined {
  const boundaryIndex = path.findIndex(({ id }) => id === boundaryMessageId);
  if (boundaryIndex === -1) {
    return undefined;
  }

  return {
    prefix: path.slice(0, boundaryIndex + 1),
    suffix: path.slice(boundaryIndex + 1),
    boundaryMessageId,
  };
}

export function createCompactInstruction({
  promptMode,
}: {
  promptMode: ContextCompactPromptMode;
}): string {
  const lookupPointerInstruction = (() => {
    switch (promptMode) {
    case 'with_message_ids':
      return `\
- Keep precise messageId=... references only where exact original wording may matter.
- Do not depend too heavily on messageId references when the compacted text itself can carry the context.
`;
    case 'without_message_ids':
      return '';
    default: {
      const _ex: never = promptMode;
      throw new Error(`Unhandled compact prompt mode: ${_ex}`);
    }
    }
  })();

  const userLanguageInstruction = 'Write the Compact Context in the user\'s primary conversation language.';

  return `\
Convert the conversation above into a Compact Context.

Goals:
- Preserve the context needed for normal continuation.
- Prioritize details that are easy to lose or misinfer from general knowledge alone.
- Make the Compact Context sufficient for continuing the conversation without the original prefix.
${lookupPointerInstruction}Keep general background short.
- Do not add facts that are not present in the conversation.
- Do not treat past assistant statements as user requirements or confirmed facts unless the user accepted them.
- The output will become an editable assistant message at the start of a compact branch.
${userLanguageInstruction}

Output exactly in this Markdown structure:
# Compact Context

## Conversation State

## Non-Obvious Context

## Settled Direction

## Open Threads

## Lookup Pointers`;
}

export function createCompactConversationMessageContent({
  node,
  promptMode,
}: {
  node: MessageNode;
  promptMode: ContextCompactPromptMode;
}): string {
  const content = node.content ?? '';
  switch (promptMode) {
  case 'with_message_ids':
    // The messageId prefix may reduce inference-cache reuse, but it makes sysfs-based
    // source lookup much more reliable for compact branches.
    return `messageId=${node.id}\n\n${content}`;
  case 'without_message_ids':
    return content;
  default: {
    const _ex: never = promptMode;
    throw new Error(`Unhandled compact prompt mode: ${_ex}`);
  }
  }
}

export function buildCompactRequestMessages({
  prefix,
  promptMode,
  instructionContent,
}: {
  prefix: readonly ChatMessage[];
  promptMode: ContextCompactPromptMode;
  instructionContent: string | undefined;
}): ChatMessage[] {
  return [
    ...prefix,
    {
      role: 'user',
      content: instructionContent ?? createCompactInstruction({
        promptMode,
      }),
    },
  ];
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
    return new (await import('@/services/lm/openai')).OpenAIProvider({
      endpoint: endpointUrl,
      headers: endpointHttpHeaders,
    });
  case 'ollama':
    if (!endpointUrl) {
      throw new Error('Ollama compact provider requires an endpoint URL.');
    }
    return new (await import('@/services/lm/ollama')).OllamaProvider({
      endpoint: endpointUrl,
      headers: endpointHttpHeaders,
    });
  case 'transformers_js':
    return new (await import('@/services/transformers-js/provider')).TransformersJsProvider();
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
        switch (toolResult.status) {
        case 'success':
          switch (toolResult.content.type) {
          case 'text':
            toolContent = toolResult.content.text;
            break;
          case 'binary_object': {
            const blob = await storageService.getFile({ binaryObjectId: toolResult.content.id });
            toolContent = blob ? await blob.text() : '[Error: Binary object missing]';
            break;
          }
          default: {
            const _ex: never = toolResult.content;
            throw new Error(`Unhandled tool success content type: ${_ex}`);
          }
          }
          break;
        case 'error':
          switch (toolResult.error.message.type) {
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
            const _ex: never = toolResult.error.message;
            throw new Error(`Unhandled tool error content type: ${_ex}`);
          }
          }
          break;
        case 'executing':
          toolContent = '[Error: Tool still executing]';
          break;
        default: {
          const _ex: never = toolResult;
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
        switch (part.type) {
        case 'text':
          return part.text;
        case 'image_url':
          return '[image attachment]';
        default: {
          const _ex: never = part;
          throw new Error(`Unhandled compact preview part: ${_ex}`);
        }
        }
      }).join('\n');
    })();

    return `[${message.role}]\n${content}`;
  }).join('\n\n');
}

function cloneToolCalls({
  toolCalls,
}: {
  toolCalls: ToolCall[] | undefined;
}): ToolCall[] | undefined {
  return toolCalls?.map(({ id, type, function: fn }) => ({
    id,
    type,
    function: {
      name: fn.name,
      arguments: fn.arguments,
    },
  }));
}

function cloneResults({
  results,
}: {
  results: ToolExecutionResult[] | undefined;
}): ToolExecutionResult[] | undefined {
  return results?.map((result) => {
    const resultStatus = result.status;
    switch (resultStatus) {
    case 'executing':
      return {
        toolCallId: result.toolCallId,
        status: 'executing',
      };
    case 'success':
      return {
        toolCallId: result.toolCallId,
        status: 'success',
        content: (() => {
          switch (result.content.type) {
          case 'text':
            return { type: 'text', text: result.content.text } as const;
          case 'binary_object':
            return { type: 'binary_object', id: result.content.id } as const;
          default: {
            const _ex: never = result.content;
            throw new Error(`Unhandled tool success content: ${_ex}`);
          }
          }
        })(),
      };
    case 'error':
      return {
        toolCallId: result.toolCallId,
        status: 'error',
        error: {
          code: result.error.code,
          message: (() => {
            switch (result.error.message.type) {
            case 'text':
              return { type: 'text', text: result.error.message.text } as const;
            case 'binary_object':
              return { type: 'binary_object', id: result.error.message.id } as const;
            default: {
              const _ex: never = result.error.message;
              throw new Error(`Unhandled tool error message: ${_ex}`);
            }
            }
          })(),
        },
      };
    default: {
      const _ex: never = resultStatus;
      throw new Error(`Unhandled tool execution result: ${_ex}`);
    }
    }
  });
}

function cloneAttachments({
  attachments,
}: {
  attachments: Attachment[] | undefined;
}): Attachment[] | undefined {
  return attachments?.map((attachment) => {
    switch (attachment.status) {
    case 'persisted':
      return { ...attachment };
    case 'missing':
      return { ...attachment };
    case 'memory':
      return { ...attachment, blob: attachment.blob };
    default: {
      const _ex: never = attachment;
      throw new Error(`Unhandled attachment clone status: ${_ex}`);
    }
    }
  });
}

function cloneLmParameters({
  lmParameters,
}: {
  lmParameters: LmParameters | undefined;
}): LmParameters | undefined {
  return lmParameters
    ? JSON.parse(JSON.stringify(lmParameters)) as LmParameters
    : undefined;
}

function cloneLinearMessageNode({
  node,
  id,
  timestamp,
}: {
  node: MessageNode;
  id: string;
  timestamp: number;
}): MessageNode {
  switch (node.role) {
  case 'user':
    return {
      id,
      role: 'user',
      content: node.content,
      attachments: cloneAttachments({ attachments: node.attachments }),
      timestamp,
      replies: { items: [] },
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: cloneLmParameters({ lmParameters: node.lmParameters }),
      toolCalls: undefined,
      results: undefined,
    };
  case 'assistant':
    return {
      id,
      role: 'assistant',
      content: node.content,
      attachments: undefined,
      timestamp,
      replies: { items: [] },
      thinking: node.thinking,
      error: node.error,
      modelId: node.modelId,
      lmParameters: cloneLmParameters({ lmParameters: node.lmParameters }),
      toolCalls: cloneToolCalls({ toolCalls: node.toolCalls }),
      results: undefined,
    };
  case 'system':
    return {
      id,
      role: 'system',
      content: node.content,
      attachments: undefined,
      timestamp,
      replies: { items: [] },
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: undefined,
    };
  case 'tool':
    return {
      id,
      role: 'tool',
      content: undefined,
      attachments: undefined,
      timestamp,
      replies: { items: [] },
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: cloneResults({ results: node.results }) ?? [],
    };
  default: {
    const _ex: never = node;
    throw new Error(`Unhandled message node role: ${_ex}`);
  }
  }
}

export function deepCopyCompactSuffix({
  suffix,
  createMessageId,
  now,
}: {
  suffix: readonly MessageNode[];
  createMessageId: () => string;
  now: () => number;
}): {
  copiedHead: MessageNode | undefined;
  copiedLeafId: string | undefined;
} {
  if (suffix.length === 0) {
    return {
      copiedHead: undefined,
      copiedLeafId: undefined,
    };
  }

  const copiedNodes = suffix.map((node) =>
    cloneLinearMessageNode({
      node,
      id: createMessageId(),
      timestamp: now(),
    }));

  for (let index = 0; index < copiedNodes.length - 1; index += 1) {
    copiedNodes[index]!.replies.items.push(copiedNodes[index + 1]!);
  }

  return {
    copiedHead: copiedNodes[0],
    copiedLeafId: copiedNodes[copiedNodes.length - 1]?.id,
  };
}

export function createCompactBranchFromResponse({
  compactContent,
  suffix,
  compactModelId,
  createMessageId,
  now,
}: {
  compactContent: string;
  suffix: readonly MessageNode[];
  compactModelId: string | undefined;
  createMessageId: () => string;
  now: () => number;
}): ContextCompactBranchResult {
  const compactNode: AssistantMessageNode = {
    id: createMessageId(),
    role: 'assistant',
    content: compactContent,
    timestamp: now(),
    modelId: compactModelId,
    replies: { items: [] },
    attachments: undefined,
    thinking: undefined,
    error: undefined,
    lmParameters: undefined,
    toolCalls: undefined,
    results: undefined,
  };

  const { copiedHead, copiedLeafId } = deepCopyCompactSuffix({
    suffix,
    createMessageId,
    now,
  });

  if (copiedHead !== undefined) {
    compactNode.replies.items.push(copiedHead);
  }

  return {
    compactNode,
    copiedSuffixHead: copiedHead,
    currentLeafId: copiedLeafId ?? compactNode.id,
  };
}

export function toContextCompactDisplayProgress({
  progress,
  nowMs,
}: {
  progress: ContextCompactProgress;
  nowMs: number;
}): {
  percent: number;
  title: string;
  detail: string;
  isRunning: boolean;
} {
  void nowMs;

  switch (progress.phase) {
  case 'idle':
    return {
      percent: 0,
      title: '',
      detail: '',
      isRunning: false,
    };
  case 'preparing':
    return {
      percent: 5,
      title: 'Compacting context',
      detail: `Preparing ${progress.compactedMessageCount} messages, keeping ${progress.suffixMessageCount}.`,
      isRunning: true,
    };
  case 'building_request':
    return {
      percent: 15,
      title: 'Compacting context',
      detail: 'Building compact request.',
      isRunning: true,
    };
  case 'requesting_model':
    return {
      percent: 25,
      title: 'Compacting context',
      detail: 'Waiting for the model.',
      isRunning: true,
    };
  case 'receiving_compact': {
    const percent = Math.min(85, 30 + Math.floor(Math.sqrt(progress.outputChars) * 0.6));
    return {
      percent,
      title: 'Compacting context',
      detail: `Generating Compact Context, ${progress.outputChars} chars received.`,
      isRunning: true,
    };
  }
  case 'applying_branch':
    return {
      percent: 95,
      title: 'Compacting context',
      detail: 'Applying compact branch.',
      isRunning: true,
    };
  case 'complete':
    return {
      percent: 100,
      title: 'Compacting context',
      detail: 'Complete.',
      isRunning: false,
    };
  case 'failed':
    return {
      percent: 100,
      title: 'Compacting context failed',
      detail: progress.message,
      isRunning: false,
    };
  case 'aborted':
    return {
      percent: 100,
      title: 'Compacting context',
      detail: 'Aborted.',
      isRunning: false,
    };
  default: {
    const _ex: never = progress;
    throw new Error(`Unhandled context compact progress: ${_ex}`);
  }
  }
}

export function createCompactToolMessageContent({
  messageId,
  content,
  promptMode,
}: {
  messageId: string;
  content: string;
  promptMode: ContextCompactPromptMode;
}): string {
  switch (promptMode) {
  case 'with_message_ids':
    return `messageId=${messageId}\n\n${content}`;
  case 'without_message_ids':
    return content;
  default: {
    const _ex: never = promptMode;
    throw new Error(`Unhandled compact prompt mode: ${_ex}`);
  }
  }
}

export function createCompactMultimodalContent({
  text,
  images,
}: {
  text: string;
  images: string[];
}): MultimodalContent[] {
  return [
    { type: 'text', text },
    ...images.map((url) => ({
      type: 'image_url' as const,
      image_url: { url },
    })),
  ];
}

export function createContextCompactBranch({
  compactContent,
  suffix,
}: {
  compactContent: string;
  suffix: readonly MessageNode[];
}): ContextCompactBranchResult {
  return createCompactBranchFromResponse({
    compactContent,
    suffix,
    compactModelId: undefined,
    createMessageId: () => generateId(),
    now: () => Date.now(),
  });
}
