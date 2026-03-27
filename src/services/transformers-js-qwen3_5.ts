import type { ChatMessage, ToolCall } from '@/models/types';
import type { WorkerToolDefinition } from './transformers-js.types';

export type Qwen3_5ReasoningMode = 'default' | 'enabled' | 'disabled';

export interface Qwen3_5ConversationState {
  modelId: string;
  promptHistory: string;
  messageCount: number;
  imageGridThw: unknown;
  videoGridThw: unknown;
}

export function sanitizeQwen3_5VisibleText({
  text,
}: {
  text: string;
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
  modelType: string | undefined;
  activeModelId: string | null;
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
}: {
  messages: ChatMessage[];
  tools: WorkerToolDefinition[] | undefined;
  reasoningMode: Qwen3_5ReasoningMode;
}): string {
  const sections: string[] = [];
  const firstMessage = messages[0];
  const firstSystemContent = firstMessage?.role === 'system'
    ? serializeMessageContent({ message: firstMessage })
    : '';

  if (tools && tools.length > 0) {
    sections.push(buildQwen3_5ToolUsePrelude({
      systemContent: firstSystemContent,
      tools,
    }));
  } else if (firstMessage?.role === 'system') {
    sections.push(`<|im_start|>system\n${firstSystemContent}<|im_end|>`);
  }

  const normalizedMessages = tools && firstMessage?.role === 'system'
    ? messages.slice(1)
    : messages;

  for (let index = 0; index < normalizedMessages.length; index += 1) {
    const message = normalizedMessages[index];
    if (!message) continue;

    if (message.role === 'tool') {
      if (index === 0 || normalizedMessages[index - 1]?.role !== 'tool') {
        sections.push('<|im_start|>user');
      }
      sections.push(`<tool_response>\n${serializeMessageContent({ message })}\n</tool_response>`);
      if (index === normalizedMessages.length - 1 || normalizedMessages[index + 1]?.role !== 'tool') {
        sections.push('<|im_end|>');
      }
      continue;
    }

    sections.push(serializeQwen3_5Message({ message }));
  }

  sections.push(buildQwen3_5AssistantPrefix({ reasoningMode }));
  return `${sections.join('\n')}\n`;
}

export function extractQwen3_5ConversationState({
  modelId,
  promptHistory,
  messageCount,
  imageGridThw,
  videoGridThw,
}: {
  modelId: string;
  promptHistory: string;
  messageCount: number;
  imageGridThw: unknown;
  videoGridThw: unknown;
}): Qwen3_5ConversationState {
  return {
    modelId,
    promptHistory,
    messageCount,
    imageGridThw,
    videoGridThw,
  };
}

export function buildQwen3_5NoToolContinuationPrompt({
  promptHistory,
  message,
  reasoningMode,
}: {
  promptHistory: string;
  message: ChatMessage;
  reasoningMode: Qwen3_5ReasoningMode;
}): string {
  const trimmedPromptHistory = promptHistory.endsWith('\n')
    ? promptHistory.slice(0, -1)
    : promptHistory;
  return `${trimmedPromptHistory}\n${serializeQwen3_5UserTurnForContinuation({ message, reasoningMode })}`;
}

export function isQwen3_5NoToolContinuationCandidate({
  messages,
  conversationState,
  activeModelId,
}: {
  messages: ChatMessage[];
  conversationState: Qwen3_5ConversationState | undefined;
  activeModelId: string | null;
}): boolean {
  if (!conversationState || conversationState.modelId !== activeModelId) return false;
  if (messages.length !== conversationState.messageCount + 1) return false;

  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== 'user') return false;

  return messages.every((message, index) => {
    if (index === messages.length - 1) return true;
    return !message.tool_calls?.length && !message.tool_call_id;
  });
}

export function applyQwen3_5ConversationState({
  inputs,
  conversationState,
}: {
  inputs: Record<string, unknown>;
  conversationState: Qwen3_5ConversationState | undefined;
}): Record<string, unknown> {
  const mergedInputs = { ...inputs };

  if (conversationState && !('image_grid_thw' in mergedInputs) && conversationState.imageGridThw !== undefined) {
    mergedInputs['image_grid_thw'] = conversationState.imageGridThw;
  }
  if (conversationState && !('video_grid_thw' in mergedInputs) && conversationState.videoGridThw !== undefined) {
    mergedInputs['video_grid_thw'] = conversationState.videoGridThw;
  }

  delete mergedInputs['pixel_values'];
  delete mergedInputs['pixel_values_videos'];
  if (mergedInputs['image_grid_thw'] == null) delete mergedInputs['image_grid_thw'];
  if (mergedInputs['video_grid_thw'] == null) delete mergedInputs['video_grid_thw'];

  return mergedInputs;
}

function buildQwen3_5ToolUsePrelude({
  systemContent,
  tools,
}: {
  systemContent: string;
  tools: WorkerToolDefinition[];
}): string {
  const toolLines = tools.map((tool) => JSON.stringify(tool)).join('\n');
  const systemPrefix = systemContent ? `${systemContent}\n\n` : '';

  // Match the model's native tool-use template structure so manual prompt
  // building stays aligned with Qwen's expected serialized history.
  return `<|im_start|>system
${systemPrefix}# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
${toolLines}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call><|im_end|>`;
}

function serializeQwen3_5Message({
  message,
}: {
  message: ChatMessage;
}): string {
  if (message.role === 'user') {
    return `<|im_start|>user\n${serializeMessageContent({ message })}<|im_end|>`;
  }
  if (message.role === 'assistant') {
    return serializeAssistantMessage({ message });
  }
  if (message.role === 'system') {
    return `<|im_start|>system\n${serializeMessageContent({ message })}<|im_end|>`;
  }
  if (message.role === 'developer') {
    return `<|im_start|>system\n${serializeMessageContent({ message })}<|im_end|>`;
  }
  if (message.role === 'tool') {
    return `<tool_response>\n${serializeMessageContent({ message })}\n</tool_response>`;
  }
  throw new Error(`Unhandled Qwen3.5 role: ${String(message.role)}`);
}

function serializeQwen3_5UserTurnForContinuation({
  message,
  reasoningMode,
}: {
  message: ChatMessage;
  reasoningMode: Qwen3_5ReasoningMode;
}): string {
  return `<|im_start|>user\n${serializeMessageContent({ message })}<|im_end|>\n${buildQwen3_5AssistantPrefix({ reasoningMode })}`;
}

function buildQwen3_5AssistantPrefix({
  reasoningMode,
}: {
  reasoningMode: Qwen3_5ReasoningMode;
}): string {
  switch (reasoningMode) {
  case 'enabled':
    return '<|im_start|>assistant\n<think>\n';
  case 'disabled':
    return '<|im_start|>assistant\n<think>\n\n</think>\n\n';
  case 'default':
    return '<|im_start|>assistant';
  default: {
    const exhaustive: never = reasoningMode;
    throw new Error(`Unhandled Qwen3.5 reasoning mode: ${exhaustive}`);
  }
  }
}

function serializeAssistantMessage({
  message,
}: {
  message: ChatMessage;
}): string {
  const parts = [`<|im_start|>assistant`];

  const content = serializeMessageContent({ message });
  if (content.length > 0) {
    parts.push(content);
  }

  if (message.tool_calls?.length) {
    for (const toolCall of message.tool_calls) {
      parts.push(serializeToolCall({ toolCall }));
    }
  }

  parts.push('<|im_end|>');
  return parts.join('\n');
}

function serializeToolCall({
  toolCall,
}: {
  toolCall: ToolCall;
}): string {
  const parsedArguments = parseToolArguments({ argumentsText: toolCall.function.arguments });
  return `<tool_call>\n${JSON.stringify({ name: toolCall.function.name, arguments: parsedArguments })}\n</tool_call>`;
}

function serializeMessageContent({
  message,
}: {
  message: ChatMessage;
}): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

function parseToolArguments({
  argumentsText,
}: {
  argumentsText: string;
}): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeQwen3_5ToolCallsForTemplate({
  toolCalls,
}: {
  toolCalls: ToolCall[];
}): Array<Omit<ToolCall, 'function'> & { function: Omit<ToolCall['function'], 'arguments'> & { arguments: Record<string, unknown> } }> {
  return toolCalls.map(toolCall => ({
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: parseToolArguments({ argumentsText: toolCall.function.arguments }),
    },
  }));
}

export function applyQwen3_5ContinuationState({
  inputs,
  continuationState,
}: {
  inputs: Record<string, unknown>;
  continuationState: {
    modelId: string;
    pastKeyValues?: unknown;
    imageGridThw: unknown;
    videoGridThw: unknown;
  } | undefined;
}): Record<string, unknown> {
  return applyQwen3_5ConversationState({
    inputs,
    conversationState: continuationState ? {
      modelId: continuationState.modelId,
      promptHistory: '',
      messageCount: 0,
      imageGridThw: continuationState.imageGridThw,
      videoGridThw: continuationState.videoGridThw,
    } : undefined,
  });
}

export function shouldRetryQwen3_5WithoutContinuation({
  error,
  isQwen3_5ToolContinuation,
}: {
  error: unknown;
  isQwen3_5ToolContinuation: boolean;
}): boolean {
  return isQwen3_5ToolContinuation
    && error instanceof Error
    && error.message.includes("Cannot read properties of undefined (reading 'inputNames')");
}

export function buildQwen3_5ToolContinuationPrompt({
  promptHistory,
  messages,
}: {
  promptHistory: string;
  messages: ChatMessage[];
}): string {
  const trimmedPromptHistory = promptHistory.endsWith('\n')
    ? promptHistory.slice(0, -1)
    : promptHistory;
  const serializedToolMessages = messages
    .filter((message): message is ChatMessage & { role: 'tool' } => message.role === 'tool')
    .map(message => `<tool_response>\n${serializeMessageContent({ message })}\n</tool_response>`)
    .join('\n');
  return `${trimmedPromptHistory}\n${serializedToolMessages}\n${buildQwen3_5AssistantPrefix({ reasoningMode: 'enabled' })}`;
}
