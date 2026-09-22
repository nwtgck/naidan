// Test-only harness using the real common consumer and tool runner.
import type { LmProvider } from '@/01-models/lm';
import type { AssistantMessageNode, ToolMessageNode } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toMessageId } from '@/01-models/ids';
import { createChatMessageSnapshot } from '@/01-models/chat-message';
import { generateChatTurn } from '@/logic/generate-chat-turn';
import type { GenerationCallback, GenerationResult } from '@/features/llama-cpp-browser/types';

export function chatRequest(): Parameters<LmProvider['chat']>[0] {
  return { messages: [{ id: toMessageId({ raw: 'u' }), role: 'user', parts: [{ type: 'text', text: 'hello', completeness: 'complete' }] }],
    model: 'local.gguf', parameters: undefined, tools: undefined, readBinaryObject: undefined, debug: undefined, signal: undefined };
}
export async function deliverNativeResult({ result, onEvent }: { result: GenerationResult, onEvent: GenerationCallback }): Promise<GenerationResult> {
  if (result.reasoningContent) await onEvent({ event: { type: 'reasoning', text: result.reasoningContent } });
  if (result.content) await onEvent({ event: { type: 'text', text: result.content } });
  for (const [index, toolCall] of result.toolCalls.entries()) {
    await onEvent({ event: { type: 'tool_call_start', index } });
    switch (result.finishReason) {
    case 'stop': await onEvent({ event: { type: 'tool_call', index, toolCall } }); break;
    case 'length': case 'stop_sequence': break;
    default: { const exhaustive: never = result.finishReason; throw new Error(`Unknown fixture completion: ${exhaustive}`); }
    }
  }
  return result;
}
export function finalText({ text }: { text: string }): GenerationResult {
  return { content: text, reasoningContent: '', toolCalls: [], finishReason: 'stop' };
}
export function createChatFixture({ provider, request, tools, controller, onToolEvent, approvalContext }: {
  provider: LmProvider, request: Parameters<LmProvider['chat']>[0], tools: readonly Tool[], controller: AbortController,
  onToolEvent: Parameters<typeof generateChatTurn>[0]['onToolEvent'],
  approvalContext: Parameters<typeof generateChatTurn>[0]['approvalContext'],
}) {
  const nodes: (AssistantMessageNode | ToolMessageNode)[] = [];
  // The approval context belongs to the actual caller, not the Provider.
  const run = () => generateChatTurn({
    provider, model: request.model, parameters: request.parameters, debug: request.debug, tools,
    readBinaryObject: request.readBinaryObject, abortController: controller, approvalContext,
    createAssistantMessage: () => {
      const node: AssistantMessageNode = { id: toMessageId({ raw: `assistant_${nodes.length}` }), role: 'assistant', createdAt: 1,
        modelId: undefined, lmParameters: undefined, interruption: undefined, parts: [], replies: { items: [] } };
      nodes.push(node); return node;
    },
    createToolMessage: () => {
      const node: ToolMessageNode = { id: toMessageId({ raw: `tool_${nodes.length}` }), role: 'tool', createdAt: 1,
        modelId: undefined, lmParameters: undefined, parts: [], replies: { items: [] } };
      nodes.push(node); return node;
    },
    buildMessages: ({ excludedMessageId }) => [...request.messages, ...nodes.filter(n => n.id !== excludedMessageId).map(node => createChatMessageSnapshot({ node }))],
    onChange: () => {}, onToolEvent,
    persistToolContent: async ({ text }) => ({ type: 'text', text }), describeError: ({ error }) => error.message,
  });
  return { run, nodes };
}
export const TEST_ONLY = {
};
