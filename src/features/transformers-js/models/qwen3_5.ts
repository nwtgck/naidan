import type { ChatMessage, ToolCall } from '@/01-models/types';
import type { WorkerToolDefinition } from '@/features/transformers-js/types';
import { z } from 'zod';

export type Qwen3_5ReasoningMode = 'default' | 'enabled' | 'disabled';

export interface Qwen3_5TemplateRenderer {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the native tokenizer method and preserves its receiver.
  apply_chat_template(messages: Array<{ role: string; content: ChatMessage['content']; tool_calls?: unknown[]; tool_call_id?: ChatMessage['tool_call_id'] }>, options: {
    tokenize: false; add_generation_prompt: true; tools?: WorkerToolDefinition[]; enable_thinking?: boolean;
  }): string;
}

export interface Qwen3_5ConversationState {
  modelId: string,
  messageCount: number,
}

export function sanitizeQwen3_5VisibleText({
  text,
}: {
  text: string,
}): string {
  return text
    .replace(/<\|im_end\|>/g, '')
    .replace(/<\|im_start\|>/g, '')
    .replace(/^\n+/, '');
}

export function isQwen3_5Model({
  modelType,
  activeModelId,
}: {
  modelType: string | undefined,
  activeModelId: string | null,
}): boolean {
  switch (modelType) {
  case 'qwen3_5':
  case 'qwen3_5_text':
  case 'qwen3_5_moe':
  case 'qwen3_5_moe_text':
    return true;
  default:
    break;
  }

  const normalizedModelId = activeModelId?.toLowerCase();
  return normalizedModelId?.includes('qwen3.5') === true || normalizedModelId?.includes('qwen3_5') === true;
}

export function buildQwen3_5Prompt({
  messages,
  tools,
  reasoningMode,
  tokenizer,
}: {
  messages: ChatMessage[],
  tools: WorkerToolDefinition[] | undefined,
  reasoningMode: Qwen3_5ReasoningMode,
  tokenizer: Qwen3_5TemplateRenderer,
}): string {
  const thinking = (() => {
    switch (reasoningMode) {
    case 'default': return {};
    case 'enabled': return { enable_thinking: true };
    case 'disabled': return { enable_thinking: false };
    default: { const exhaustive: never = reasoningMode; throw new Error(`Unhandled Qwen reasoning mode: ${exhaustive}`); }
    }
  })();
  // Undefined effort is intentionally absent: different native model templates
  // have different defaults. Never add whitespace to the rendered suffix.
  return tokenizer.apply_chat_template(messages.map(message => ({
    ...message,
    role: message.role === 'developer' ? 'system' : message.role,
    ...(message.tool_calls === undefined ? {} : { tool_calls: normalizeQwen3_5ToolCallsForTemplate({ toolCalls: message.tool_calls }) }),
  })), { tokenize: false, add_generation_prompt: true, ...thinking, ...(tools?.length ? { tools } : {}) });
}

export type Qwen3_5NoToolContinuationEligibility =
  | { status: 'eligible' }
  | {
      status: 'ineligible',
      reason:
        | 'missing-conversation-state'
        | 'model-mismatch'
        | 'message-count-mismatch'
        | 'last-message-is-not-user'
        | 'preceding-message-is-not-assistant'
        | 'tool-history-present',
    };

export function assessQwen3_5NoToolContinuationEligibility({
  messages,
  conversationState,
  activeModelId,
}: {
  messages: ChatMessage[],
  conversationState: Qwen3_5ConversationState | undefined,
  activeModelId: string | null,
}): Qwen3_5NoToolContinuationEligibility {
  if (conversationState === undefined) {
    return { status: 'ineligible', reason: 'missing-conversation-state' };
  }
  if (conversationState.modelId !== activeModelId) {
    return { status: 'ineligible', reason: 'model-mismatch' };
  }
  if (messages.length !== conversationState.messageCount + 2) {
    return { status: 'ineligible', reason: 'message-count-mismatch' };
  }

  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== 'user') {
    return { status: 'ineligible', reason: 'last-message-is-not-user' };
  }
  if (messages.at(-2)?.role !== 'assistant') return { status: 'ineligible', reason: 'preceding-message-is-not-assistant' };

  const hasToolHistory = messages.some((message, index) => (
    index !== messages.length - 1
    && ((message.tool_calls?.length ?? 0) > 0 || message.tool_call_id !== undefined)
  ));
  if (hasToolHistory) {
    return { status: 'ineligible', reason: 'tool-history-present' };
  }

  return { status: 'eligible' };
}

export function normalizeQwen3_5ProcessorInputs({
  inputs,
}: {
  inputs: Record<string, unknown>,
}): Record<string, unknown> {
  const mergedInputs = { ...inputs };

  if (mergedInputs['pixel_values'] == null) delete mergedInputs['pixel_values'];
  if (mergedInputs['pixel_values_videos'] == null) delete mergedInputs['pixel_values_videos'];
  if (mergedInputs['image_grid_thw'] == null) delete mergedInputs['image_grid_thw'];
  if (mergedInputs['video_grid_thw'] == null) delete mergedInputs['video_grid_thw'];

  return mergedInputs;
}

export function normalizeQwen3_5ToolCallsForTemplate({
  toolCalls,
}: {
  toolCalls: ToolCall[],
}): Array<Omit<ToolCall, 'function'> & { function: Omit<ToolCall['function'], 'arguments'> & { arguments: Record<string, unknown> } }> {
  return toolCalls.map(toolCall => ({
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: z.custom<Record<string, unknown>>(value => typeof value === 'object' && value !== null && !Array.isArray(value)).parse(JSON.parse(toolCall.function.arguments) as unknown),
    },
  }));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
