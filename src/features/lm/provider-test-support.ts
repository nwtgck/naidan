// Test harness for the former conversation-level tests. Production providers expose
// only the new generation API; orchestration here uses the real shared runner.
import type { LmProvider } from '@/01-models/lm';
import type { Tool, ToolExecutionOutcome, ToolExecutionEvent } from '@/01-models/tool';
import type { ToolApprovalContext } from '@/01-models/tool-approval';
import type { AssistantMessageNode, MessageNode, LmParameters, ToolCall } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { toMessageId, toAttachmentId, toBinaryObjectId, type ToolCallId } from '@/01-models/ids';
import { createChatMessageSnapshot } from '@/01-models/chat-message';
import { generateChatTurn } from '@/logic/generate-chat-turn';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';

export async function runProviderConversationForTest({ provider, messages, model, parameters, tools, signal, onChunk, onReasoning, onToolCall, onToolResult, onToolEvent, onAssistantMessageStart, toolApprovalContext }: {
  provider: LmProvider,
  messages: {
    role: string,
    content?: string | ({ type: 'text', text: string } | { type: 'image_url', image_url: { url: string } })[],
    tool_calls?: ToolCall[],
    tool_call_id?: ToolCallId,
  }[],
  model: string,
  parameters?: Partial<LmParameters>,
  tools?: Tool[],
  signal?: AbortSignal,
  onChunk: ({ chunk }: { chunk: string }) => void,
  onReasoning?: ({ chunk }: { chunk: string }) => void,
  onToolCall?: ({ id, toolName, modelVisibleArguments }: { id: ToolCallId, toolName: string, modelVisibleArguments: string }) => void,
  onToolResult?: ({ id, result }: { id: ToolCallId, result: ToolExecutionOutcome }) => void,
  onToolEvent?: ({ id, event }: { id: ToolCallId, event: ToolExecutionEvent }) => void,
  onAssistantMessageStart?: () => void,
  toolApprovalContext?: ToolApprovalContext,
}): Promise<MessageNode[]> {
  const history: MessageNode[] = [];
  for (const [index, message] of messages.entries()) {
    const common = { id: toMessageId({ raw: `history_${index}` }), createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
    const content = message.content ?? '';
    const parts = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
    switch (message.role) {
    case 'user': {
      const converted: Extract<MessageNode, { role: 'user' }>['parts'] = [];
      for (const [position, part] of parts.entries()) {
        switch (part.type) {
        case 'text': converted.push({ type: 'text', text: part.text, completeness: 'complete' }); break;
        case 'image_url': {
          const encoded = part.image_url.url.split(',');
          const bytes = Uint8Array.from(atob(encoded.at(-1)!), c => c.charCodeAt(0));
          converted.push({ type: 'attachment', attachment: { id: toAttachmentId({ raw: `a_${position}` }), binaryObjectId: toBinaryObjectId({ raw: `b_${position}` }), originalName: 'image', mimeType: 'image/png', size: bytes.length, uploadedAt: 1, status: 'memory', blob: new Blob([bytes], { type: 'image/png' }) } });
          break;
        }
        default: { const _ex: never = part; throw new Error(`Unexpected fixture content: ${_ex}`); }
        }
      }
      history.push({ ...common, role: 'user', parts: converted }); break;
    }
    case 'system': history.push({ ...common, role: 'system', parts: [{ type: 'text', text: String(content), completeness: 'complete' }] }); break;
    case 'assistant': history.push({ ...common, role: 'assistant', interruption: undefined, parts: [
      { type: 'text', text: String(content), completeness: 'complete' },
      ...(message.tool_calls ?? []).map(toolCall => ({ type: 'tool_call' as const, toolCall })),
    ] }); break;
    case 'tool': {
      if (!message.tool_call_id) throw new Error('Fixture tool call ID is required.');
      history.push({ ...common, role: 'tool', parts: [{ type: 'tool_result', result: { toolCallId: message.tool_call_id, status: 'success', content: { type: 'text', text: String(content) } } }] }); break;
    }
    default: throw new Error('Unknown fixture role.');
    }
  }
  const controller = new AbortController();
  const relay = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', relay, { once: true });
  if (signal?.aborted) relay();
  const starting = history.length;
  const deliveredText = new Map<AssistantMessageNode['parts'][number], number>();
  const deliveredCalls = new Set<ToolCallId>();
  const deliveredResults = new Set<ToolCallId>();
  try {
    const result = await generateChatTurn({
      debug: undefined,
      provider, model, parameters: parameters ? { ...EMPTY_LM_PARAMETERS, ...parameters } : undefined,
      tools: tools ?? [], readBinaryObject: undefined, abortController: controller, approvalContext: toolApprovalContext,
      createAssistantMessage: () => {
        const node: AssistantMessageNode = { id: toMessageId({ raw: `generated_${history.length}` }), role: 'assistant', parts: [], createdAt: 1, interruption: undefined, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
        history.push(node); onAssistantMessageStart?.(); return node;
      },
      createToolMessage: () => {
        const node: Extract<MessageNode, { role: 'tool' }> = { id: toMessageId({ raw: `tool_${history.length}` }), role: 'tool', parts: [], createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
        history.push(node); return node;
      },
      buildMessages: ({ excludedMessageId }) => history.filter(node => node.id !== excludedMessageId).map(node => createChatMessageSnapshot({ node })),
      onChange: () => {
        for (const node of history.slice(starting)) {
          switch (node.role) {
          case 'assistant':
            for (const part of node.parts) {
              switch (part.type) {
              case 'text':
              case 'reasoning': {
                const used = deliveredText.get(part) ?? 0;
                const chunk = part.text.slice(used); deliveredText.set(part, part.text.length);
                if (chunk) {
                  switch (part.type) {
                  case 'text': onChunk({ chunk }); break;
                  case 'reasoning': onReasoning?.({ chunk }); break;
                  default: { const _ex: never = part; throw new Error(`Unknown fixture part: ${_ex}`); }
                  }
                }
                break;
              }
              case 'tool_call':
                if (!deliveredCalls.has(part.toolCall.id)) {
                  deliveredCalls.add(part.toolCall.id);
                  onToolCall?.({ id: part.toolCall.id, toolName: part.toolCall.function.name, modelVisibleArguments: part.toolCall.function.arguments });
                }
                break;
              default: { const _ex: never = part; throw new Error(`Unknown fixture part: ${_ex}`); }
              }
            }
            break;
          case 'tool':
            for (const part of node.parts) {
              if (deliveredResults.has(part.result.toolCallId)) continue;
              switch (part.result.status) {
              case 'executing': break;
              case 'success':
                switch (part.result.content.type) {
                case 'text': break;
                case 'binary_object': throw new Error('Unexpected binary result in fixture.');
                default: { const _ex: never = part.result.content; throw new Error(`Unexpected fixture content: ${_ex}`); }
                }
                onToolResult?.({ id: part.result.toolCallId, result: { status: 'success', content: part.result.content.text } });
                deliveredResults.add(part.result.toolCallId); break;
              case 'error':
                switch (part.result.error.message.type) {
                case 'text': break;
                case 'binary_object': throw new Error('Unexpected binary error in fixture.');
                default: { const _ex: never = part.result.error.message; throw new Error(`Unexpected fixture content: ${_ex}`); }
                }
                onToolResult?.({ id: part.result.toolCallId, result: { status: 'error', code: part.result.error.code, message: part.result.error.message.text } });
                deliveredResults.add(part.result.toolCallId); break;
              default: { const _ex: never = part.result; throw new Error(`Unknown fixture result: ${_ex}`); }
              }
            }
            break;
          case 'user':
          case 'system': break;
          default: { const _ex: never = node; throw new Error(`Unknown fixture message: ${_ex}`); }
          }
        }
      },
      onToolEvent: ({ toolCallId, event }) => onToolEvent?.({ id: toolCallId, event }),
      persistToolContent: async ({ text }) => ({ type: 'text', text }),
      describeError: ({ error }) => error.message,
    });
    switch (result.type) {
    case 'finished': return history;
    case 'error': throw result.error;
    case 'interrupted': throw new Error(`Generation ${result.reason}`);
    default: { const _ex: never = result; throw new Error(`Unknown generation result: ${_ex}`); }
    }
  } finally {
    signal?.removeEventListener('abort', relay);
  }
}

/** Consume a single real generation; preserve both partial content and its result. */
export async function consumeProviderGenerationForTest({ provider, request }: {
  provider: Pick<LmProvider, 'chat'>,
  request: Parameters<LmProvider['chat']>[0],
}) {
  const node: AssistantMessageNode = {
    id: toMessageId({ raw: 'generated' }), role: 'assistant', parts: [],
    createdAt: 1, modelId: undefined, lmParameters: undefined,
    interruption: undefined, replies: { items: [] },
  };
  const abortController = new AbortController();
  const relay = () => abortController.abort(request.signal?.reason);
  request.signal?.addEventListener('abort', relay, { once: true });
  if (request.signal?.aborted) relay();
  try {
    const result = await consumeChatGeneration({
      node, items: provider.chat({ ...request, signal: abortController.signal }),
      abortController, onChange: () => {},
    });
    return { node, result };
  } finally {
    request.signal?.removeEventListener('abort', relay);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
