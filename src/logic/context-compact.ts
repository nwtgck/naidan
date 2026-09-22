import { generateId } from '@/01-models/id';
import { LlamaCppBrowserProvider } from '@/features/llama-cpp-browser/provider';
import type { AssistantMessageNode, ChatMessage, Endpoint, MessageNode, MultimodalContent } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import type { LmProvider } from '@/01-models/lm';
import { copyChatMessage, createChatMessageSnapshot } from '@/01-models/chat-message';
import { copyMessageWithoutReplies } from '@/logic/copy-message-node';
import { getMessageText } from '@/01-models/message-text';
import { idToRaw, toMessageId } from '@/01-models/ids';
import type { BinaryObjectId, MessageId } from '@/01-models/ids';

export type ContextCompactProgress =
  | { phase: 'idle' }
  | {
      phase: 'preparing',
      compactedMessageCount: number,
      suffixMessageCount: number,
    }
  | {
      phase: 'building_request',
      compactedMessageCount: number,
      suffixMessageCount: number,
      requestPreview: string | undefined,
    }
  | {
      phase: 'requesting_model',
      compactedMessageCount: number,
      suffixMessageCount: number,
      requestPreview: string | undefined,
    }
  | {
      phase: 'receiving_compact',
      compactedMessageCount: number,
      suffixMessageCount: number,
      outputChars: number,
      requestPreview: string | undefined,
      outputPreview: string,
    }
  | {
      phase: 'applying_branch',
      outputChars: number,
      requestPreview: string | undefined,
      outputPreview: string,
    }
  | {
      phase: 'complete',
      requestPreview: string | undefined,
      outputPreview: string,
    }
  | { phase: 'failed', message: string }
  | { phase: 'aborted' };

export type ContextCompactPromptMode =
  | 'with_message_ids'
  | 'without_message_ids';

export type ContextCompactSplit = {
  prefix: MessageNode[],
  suffix: MessageNode[],
  boundaryMessageId: MessageId,
};

export type ContextCompactBranchResult = {
  compactNode: AssistantMessageNode,
  copiedSuffixHead: MessageNode | undefined,
  currentLeafId: MessageId,
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
  | 'toggle_debug'
  | 'open_chat_inspector';

export function getHeaderCompactBoundary({
  path,
  keepRecentMessages,
}: {
  path: readonly MessageNode[],
  keepRecentMessages: number,
}): MessageId | undefined {
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
  path: readonly MessageNode[],
  boundaryMessageId: MessageId,
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
  promptMode: ContextCompactPromptMode,
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

function createCompactConversationMessageContent({
  node,
  promptMode,
}: {
  node: MessageNode,
  promptMode: ContextCompactPromptMode,
}): string {
  const content = getMessageText({ message: node });
  switch (promptMode) {
  case 'with_message_ids':
    // The messageId prefix may reduce inference-cache reuse, but it makes sysfs-based
    // source lookup much more reliable for compact branches.
    return 'messageId=' + idToRaw({ id: node.id }) + '\n\n' + content;
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
  prefix: readonly ChatMessage[],
  promptMode: ContextCompactPromptMode,
  instructionContent: string | undefined,
}): ChatMessage[] {
  const messages = prefix.map(message => copyChatMessage({ message }));
  const ids = new Set(messages.map(message => idToRaw({ id: message.id })));
  let raw = 'compact_instruction';
  while (ids.has(raw)) raw += '_';
  messages.push({
    id: toMessageId({ raw }), role: 'user',
    parts: [{ type: 'text', text: instructionContent ?? createCompactInstruction({ promptMode }), completeness: 'complete' }],
  });
  return messages;
}

export async function createProviderForCompact({
  endpoint,
}: {
  endpoint: Endpoint,
}): Promise<LmProvider> {
  switch (endpoint.type) {
  case 'openai':
    if (endpoint.url === '') {
      throw new Error('OpenAI compact provider requires an endpoint URL.');
    }
    return new (await import('@/features/lm/openai')).OpenAIProvider({
      endpoint: endpoint.url,
      headers: endpoint.httpHeaders,
    });
  case 'ollama':
    if (endpoint.url === '') {
      throw new Error('Ollama compact provider requires an endpoint URL.');
    }
    return new (await import('@/features/lm/ollama')).OllamaProvider({
      endpoint: endpoint.url,
      headers: endpoint.httpHeaders,
    });
  case 'transformers_js':
    return new (await import('@/features/transformers-js/provider')).TransformersJsProvider();
  case 'llama_cpp_browser':
    return new LlamaCppBrowserProvider();
  case 'browser_provided_lm':
    return new (await import('@/features/prompt-api/provider')).PromptApiProvider();
  case 'unsupported_experimental_endpoint':
    throw new Error(`Unsupported experimental endpoint: ${String(endpoint.persistedType)}`);
  default: {
    const _ex: never = endpoint;
    throw new Error(`Unsupported endpoint type: ${_ex}`);
  }
  }
}

export async function createCompactChatMessagesFromPrefix({
  prefix,
  promptMode,
}: {
  prefix: readonly MessageNode[],
  promptMode: ContextCompactPromptMode,
}): Promise<ChatMessage[]> {
  // Capture every message before any binary read yields. Lookup annotations are
  // request-only; neither the source history nor its part boundaries are changed.
  const messages = prefix.map(node => createChatMessageSnapshot({ node }));
  switch (promptMode) {
  case 'without_message_ids': return messages;
  case 'with_message_ids': break;
  default: { const _ex: never = promptMode; throw new Error(`Unhandled compact prompt mode: ${_ex}`); }
  }
  return Promise.all(messages.map(async message => {
    switch (message.role) {
    case 'user': return { ...message, parts: addCompactLookupText({ parts: message.parts, messageId: message.id }) };
    case 'assistant': return { ...message, parts: addCompactLookupText({ parts: message.parts, messageId: message.id }) };
    case 'system': return { ...message, parts: addCompactLookupText({ parts: message.parts, messageId: message.id }) };
    case 'tool': return {
      ...message,
      parts: await Promise.all(message.parts.map(async part => {
        const result = part.result;
        const annotate = async ({ content }: { content: { type: 'text', text: string } | { type: 'binary_object', id: BinaryObjectId } }) => {
          let text: string;
          switch (content.type) {
          case 'text': text = content.text; break;
          case 'binary_object': {
            const blob = await storageService.getFile({ binaryObjectId: content.id });
            if (!blob) throw new Error('Cannot compact a missing tool result.');
            // Match inline tool text, including a leading BOM; corrupt bytes must not
            // become replacement characters inside the annotated model input.
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await blob.arrayBuffer());
            break;
          }
          default: { const _ex: never = content; throw new Error(`Unhandled tool content: ${_ex}`); }
          }
          return { type: 'text' as const, text: createCompactToolMessageContent({ messageId: message.id, content: text, promptMode }) };
        };
        switch (result.status) {
        case 'success': return { ...part, result: { ...result, content: await annotate({ content: result.content }) } };
        case 'error': return { ...part, result: { ...result, error: { ...result.error, message: await annotate({ content: result.error.message }) } } };
        case 'executing': throw new Error('Cannot compact a tool result that is still executing.');
        default: { const _ex: never = result; throw new Error(`Unhandled tool result: ${_ex}`); }
        }
      })),
    };
    default: { const _ex: never = message; throw new Error(`Unhandled compact message: ${_ex}`); }
    }
  }));
}

function addCompactLookupText<Part extends ChatMessage['parts'][number]>({ parts, messageId }: {
  parts: readonly Part[],
  messageId: MessageId,
}): (Part | { type: 'text', text: string, completeness: 'complete' })[] {
  let annotated = false;
  const copied = parts.map(part => {
    if (part.type !== 'text' || annotated) return part;
    annotated = true;
    return { ...part, text: createCompactToolMessageContent({ messageId, content: part.text, promptMode: 'with_message_ids' }) };
  });
  if (annotated) return copied;
  // Reasoning remains before visible text, including reasoning-only assistants.
  const next = copied.findIndex(part => part.type !== 'reasoning');
  return [
    ...copied.slice(0, next === -1 ? copied.length : next),
    { type: 'text', text: createCompactToolMessageContent({ messageId, content: '', promptMode: 'with_message_ids' }), completeness: 'complete' },
    ...copied.slice(next === -1 ? copied.length : next),
  ];
}

export function createCompactRequestPreview({
  messages,
}: {
  messages: readonly ChatMessage[],
}): string {
  // This is a diagnostic projection, never the provider input or stored content.
  return messages.map(message => {
    const content = message.parts.map(part => {
      switch (part.type) {
      case 'text': return part.text;
      case 'reasoning': return `[reasoning] ${part.text}`;
      case 'attachment': return `[attachment: ${part.attachment.originalName}]`;
      case 'tool_call': return `[tool_call: ${part.toolCall.function.name}] ${part.toolCall.function.arguments}`;
      case 'tool_result': {
        const result = part.result;
        switch (result.status) {
        case 'executing': return '[tool_result: executing]';
        case 'success': {
          switch (result.content.type) {
          case 'text': return result.content.text;
          case 'binary_object': return '[tool_result: binary object]';
          default: { const _ex: never = result.content; throw new Error(`Unhandled compact content: ${_ex}`); }
          }
        }
        case 'error': {
          switch (result.error.message.type) {
          case 'text': return result.error.message.text;
          case 'binary_object': return '[tool_result: binary error]';
          default: { const _ex: never = result.error.message; throw new Error(`Unhandled compact error: ${_ex}`); }
          }
        }
        default: { const _ex: never = result; throw new Error(`Unhandled tool result: ${_ex}`); }
        }
      }
      default: { const _ex: never = part; throw new Error(`Unhandled compact preview part: ${_ex}`); }
      }
    }).join('\n');
    return `[${message.role}]\n${content}`;
  }).join('\n\n');
}

export function deepCopyCompactSuffix({
  suffix,
  createMessageId,
  now,
}: {
  suffix: readonly MessageNode[],
  createMessageId: () => MessageId,
  now: () => number,
}): {
  copiedHead: MessageNode | undefined,
  copiedLeafId: MessageId | undefined,
} {
  if (suffix.length === 0) {
    return {
      copiedHead: undefined,
      copiedLeafId: undefined,
    };
  }

  const copiedNodes = suffix.map((node) =>
    ({ ...copyMessageWithoutReplies({ message: node }), id: createMessageId(), createdAt: now() }));

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
  compactContent: string,
  suffix: readonly MessageNode[],
  compactModelId: string | undefined,
  createMessageId: () => MessageId,
  now: () => number,
}): ContextCompactBranchResult {
  const compactNode: AssistantMessageNode = {
    id: createMessageId(),
    role: 'assistant',
    parts: [{ type: 'text', text: compactContent, completeness: 'complete' }],
    createdAt: now(),
    modelId: compactModelId,
    replies: { items: [] },
    interruption: undefined,
    lmParameters: undefined,
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
  progress: ContextCompactProgress,
  nowMs: number,
}): {
  percent: number,
  isRunning: boolean,
} {
  void nowMs;

  switch (progress.phase) {
  case 'idle':
    return { percent: 0, isRunning: false };
  case 'preparing':
    return { percent: 5, isRunning: true };
  case 'building_request':
    return { percent: 15, isRunning: true };
  case 'requesting_model':
    return { percent: 25, isRunning: true };
  case 'receiving_compact':
    return {
      percent: Math.min(85, 30 + Math.floor(Math.sqrt(progress.outputChars) * 0.6)),
      isRunning: true,
    };
  case 'applying_branch':
    return { percent: 95, isRunning: true };
  case 'complete':
  case 'failed':
  case 'aborted':
    return { percent: 100, isRunning: false };
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
  messageId: MessageId,
  content: string,
  promptMode: ContextCompactPromptMode,
}): string {
  switch (promptMode) {
  case 'with_message_ids':
    return 'messageId=' + idToRaw({ id: messageId }) + '\n\n' + content;
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
  text: string,
  images: string[],
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
  compactContent: string,
  suffix: readonly MessageNode[],
}): ContextCompactBranchResult {
  return createCompactBranchFromResponse({
    compactContent,
    suffix,
    compactModelId: undefined,
    createMessageId: () => generateId<MessageId>(),
    now: () => Date.now(),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createCompactConversationMessageContent,
};
