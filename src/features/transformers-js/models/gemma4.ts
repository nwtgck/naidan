/* eslint-disable no-restricted-imports -- Gemma 4 worker adapter intentionally depends on transformers.js runtime image utilities. */
import type { RawImage as TransformersRawImage, PreTrainedTokenizer } from '@huggingface/transformers';
import type { LmParameters, ToolCall } from '@/01-models/types';
import type { InferenceMessage } from '@/features/transformers-js/types';
import { z } from 'zod';
import { readCompleteInferenceReasoning } from '@/features/transformers-js/inference-reasoning';

export type Gemma4TemplateContentPart =
  | { type: 'text', text: string }
  | { type: 'image' };

export interface Gemma4TemplateMessage {
  role: string,
  content: string | Gemma4TemplateContentPart[],
  tool_calls?: Array<Omit<ToolCall, 'function'> & { function: Omit<ToolCall['function'], 'arguments'> & { arguments: Record<string, unknown> } }>,
  tool_call_id?: InferenceMessage['tool_call_id'],
  reasoning_content?: string,
}

export interface Gemma4ProcessorLike {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this callable mirrors the Transformers processor runtime signature.
  (
    text: string | string[],
    images: TransformersRawImage[] | TransformersRawImage | null,
    audio: Float32Array[] | Float32Array | null,
    options: Record<string, unknown>
  ): Promise<Record<string, unknown>>,
  tokenizer: PreTrainedTokenizer,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this method mirrors the Transformers tokenizer apply_chat_template signature.
  apply_chat_template(messages: Gemma4TemplateMessage[], options: Record<string, unknown>): string,
}

export function getGemma4ThinkingTemplateOptions({ parameters }: { parameters: LmParameters | undefined }): { enable_thinking?: boolean } {
  const effort = parameters?.reasoning?.effort;
  switch (effort) {
  case undefined: return {};
  case 'none': return { enable_thinking: false };
  case 'low':
  case 'medium':
  case 'high': return { enable_thinking: true };
  default: {
    const exhaustive: never = effort;
    throw new Error(`Unhandled Gemma reasoning effort: ${String(exhaustive)}`);
  }
  }
}

export function validateGemma4ToolCallsForTemplate({ toolCalls }: { toolCalls: ToolCall[] }): void {
  for (const call of toolCalls) {
    validateGemma4ToolName({ name: call.function.name });
    parseGemma4ToolArguments({ argumentsText: call.function.arguments });
  }
}

export function validateGemma4ToolName({ name }: { name: string }): void {
  if (!/^[A-Za-z0-9_$.-]+$/.test(name)) throw new Error('Gemma native tool template cannot preserve this bare tool name');
}

export function isGemma4Model({
  modelType,
  activeModelId,
}: {
  modelType: string | undefined,
  activeModelId: string | null,
}): boolean {
  if (modelType === 'gemma4') {
    return true;
  }

  const normalizedModelId = activeModelId?.toLowerCase();
  return normalizedModelId?.includes('gemma-4') === true || normalizedModelId?.includes('gemma4') === true;
}

export async function buildGemma4TemplateInput({
  messages,
}: {
  messages: InferenceMessage[],
}): Promise<{
  images: TransformersRawImage[],
  templateMessages: Gemma4TemplateMessage[],
}> {
  // Validate all framing before image decoding or asynchronous reads begin.
  const reasoningTexts = messages.map(message => readCompleteInferenceReasoning({ message }));
  const images: TransformersRawImage[] = [];
  const templateMessages: Gemma4TemplateMessage[] = [];

  for (const [index, message] of messages.entries()) {
    const { role, content, tool_calls, tool_call_id, reasoning: _reasoning, ...unhandledMessage } = message;
    unhandledMessage satisfies Record<PropertyKey, never>;
    const normalizedRole = normalizeGemma4Role({ role });
    if (normalizedRole === 'tool') {
      // The native tool-response macro quotes strings with the same unescaped
      // delimiter as arguments and concatenates text parts without separators.
      const responseText = typeof content === 'string' ? content : content
        .filter(part => part.type === 'text').map(part => part.text).join('');
      validateGemma4TemplateArgument({ value: responseText, depth: 0 });
    }
    if (tool_calls !== undefined) validateGemma4ToolCallsForTemplate({ toolCalls: tool_calls });
    const reasoning = reasoningTexts[index];
    const toolFields = {
      ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
      ...(tool_call_id === undefined ? {} : { tool_call_id }),
      ...(tool_calls === undefined ? {} : { tool_calls: tool_calls.map(call => ({
        ...call, function: { ...call.function, arguments: parseGemma4ToolArguments({ argumentsText: call.function.arguments }) },
      })) }),
    };

    // Content is model-visible text, not a display projection. Native channel
    // decoding belongs to its own codec; literal think tags are never parsed here.
    if (typeof content === 'string') {
      templateMessages.push({ role: normalizedRole, content, ...toolFields });
      continue;
    }

    if (normalizedRole === 'assistant' && content.length === 0 && tool_calls?.length) {
      // No text part is not an empty text part in common history. At this
      // template boundary, however, the call-only message must have falsey
      // content: an empty JS sequence would add a turn terminator after the
      // tool responses. Keep this format-specific choice out of stored parts.
      templateMessages.push({ role: normalizedRole, content: '', ...toolFields });
      continue;
    }

    const contentParts: Gemma4TemplateContentPart[] = [];
    for (const part of content) {
      switch (part.type) {
      case 'text':
        contentParts.push({ type: 'text', text: part.text });
        break;
      case 'image_url':
        contentParts.push({ type: 'image' });
        images.push(await readGemma4Image({ url: part.image_url.url }));
        break;
      default: {
        const exhaustive: never = part;
        throw new Error(`Unhandled Gemma 4 multimodal part: ${String(exhaustive)}`);
      }
      }
    }

    templateMessages.push({
      role: normalizedRole,
      content: contentParts,
      ...toolFields,
    });
  }

  return {
    images,
    templateMessages,
  };
}

function normalizeGemma4Role({
  role,
}: {
  role: string,
}): string {
  switch (role) {
  case 'developer':
    return 'system';
  default:
    return role;
  }
}

function parseGemma4ToolArguments({
  argumentsText,
}: {
  argumentsText: string,
}): Record<string, unknown> {
  const argumentsObject = z.custom<Record<string, unknown>>(value => typeof value === 'object' && value !== null && !Array.isArray(value))
    .parse(JSON.parse(argumentsText) as unknown);
  validateGemma4TemplateArgument({ value: argumentsObject, depth: 0 });
  return argumentsObject;
}

function validateGemma4TemplateArgument({ value, depth }: { value: unknown; depth: number }): void {
  // The native template does not escape its quote delimiter or bare keys and
  // renders null as an empty slot. Reject known lossy input; do not invent an
  // escaping convention that the native model does not use.
  if (depth > 64 || value === null) throw new Error('Gemma native tool template cannot preserve this argument value');
  switch (typeof value) {
  case 'string':
    if (value.includes('<|"|>')) throw new Error('Gemma native tool template cannot preserve a string containing its quote delimiter');
    return;
  case 'boolean': return;
  case 'number':
    if (!Number.isFinite(value)) throw new Error('Gemma native tool template requires finite numeric arguments');
    return;
  case 'object':
    if (Array.isArray(value)) {
      for (const item of value) validateGemma4TemplateArgument({ value: item, depth: depth + 1 });
    } else {
      for (const [key, item] of Object.entries(value)) {
        if (!/^[A-Za-z0-9_$.-]+$/.test(key)) throw new Error('Gemma native tool template cannot preserve this bare argument key');
        validateGemma4TemplateArgument({ value: item, depth: depth + 1 });
      }
    }
    return;
  default: throw new Error('Gemma native tool template cannot preserve this argument type');
  }
}

async function readGemma4Image({
  url,
}: {
  url: string,
}): Promise<TransformersRawImage> {
  const { RawImage } = await import('@huggingface/transformers');

  if (url.startsWith('data:')) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to read Gemma 4 image data URL: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    return RawImage.read(blob);
  }

  return RawImage.read(url);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
