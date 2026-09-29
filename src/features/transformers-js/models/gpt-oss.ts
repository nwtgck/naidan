/* eslint-disable no-restricted-imports -- Worker-only GPT-OSS helper intentionally depends on transformers.js stream primitives. */
import {
  TextStreamer,
  Tensor,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from '@huggingface/transformers';
import type { LmParameters, ToolCall } from '@/01-models/types';
import type { InferenceMessage } from '@/features/transformers-js/types';
import { HarmonyStreamParser as GptOssHarmonyStreamParser } from '@/features/transformers-js/models/gpt-oss-harmony';
import type { WorkerToolDefinition } from '@/features/transformers-js/types';
import type { ToolCallId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';
import { prepareGptOssContinuation, retainGptOssContinuation } from './gpt-oss-cache';
import { buildGptOssPromptMessages, readGptOssTextContent } from './gpt-oss-input';
import { createGptOssGeneration } from './gpt-oss-generation';
import { NativeProtocolStreamer } from './native-protocol-streamer';
import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';

interface GenerationResult {
  past_key_values: unknown,
  sequences?: unknown,
}

type GptOssInputPreparedObservation = {
  fullConversationInputs: Record<string, unknown>,
  cacheDecision: {
    status: 'reused' | 'not-reused',
    reason: string,
  },
};

type GptOssInputPreparedObserver = ({ fullConversationInputs, cacheDecision }: GptOssInputPreparedObservation) => void;

function emitGptOssInputPrepared({
  onInputPrepared,
  prepare,
}: {
  onInputPrepared: GptOssInputPreparedObserver | undefined,
  prepare: () => GptOssInputPreparedObservation,
}): void {
  if (onInputPrepared === undefined) return;
  try {
    onInputPrepared(prepare());
  } catch {
    // Investigation instrumentation is diagnostic-only. Never change the
    // Production generation path because observation or reconstruction failed.
  }
}

export async function generateGptOss({
  model,
  tokenizer,
  messages,
  onChunk,
  onToolCalls,
  params,
  tools,
  pastKeyValues,
  continuationOwner,
  stoppingCriteria,
  onInputPrepared,
  onGenerationEvent,
  generateWithModel,
}: {
  model: PreTrainedModel,
  tokenizer: PreTrainedTokenizer,
  messages: InferenceMessage[],
  onChunk: ({ chunk }: { chunk: string }) => void,
  onToolCalls: ({ toolCalls }: { toolCalls: ToolCall[] }) => void,
  params: LmParameters | undefined,
  tools: WorkerToolDefinition[] | undefined,
  pastKeyValues: unknown,
  continuationOwner?: string,
  stoppingCriteria: {
    reset(): void,
    interrupt(): void,
  },
  onInputPrepared: GptOssInputPreparedObserver | undefined,
  onGenerationEvent: (({ event }: { event: InferenceGenerationEvent }) => void) | undefined,
  generateWithModel: ({ model, inputs, pastKeyValues, params, streamer, stoppingCriteria }: {
    model: PreTrainedModel,
    inputs: Record<string, unknown>,
    pastKeyValues: unknown,
    params: LmParameters | undefined,
    streamer: TextStreamer,
    stoppingCriteria: {
      reset(): void,
      interrupt(): void,
    },
  }) => Promise<GenerationResult>,
}): Promise<unknown> {
  const isContinuation = isGptOssToolContinuationRequest({ messages });
  const fullInputs = buildGptOssFullConversationInputs({ messages, tools, tokenizer });
  const continuation = prepareGptOssContinuation({ cache: pastKeyValues, owner: continuationOwner, model, config: model.config, messages,
    buildBaseInputs: ({ messages: baseMessages }) => buildGptOssFullConversationInputs({ messages: baseMessages, tools, tokenizer }),
    buildSuffixInputs: ({ messages: suffixMessages }) => buildGptOssToolResultTokens({ messages: suffixMessages, tokenizer }), tensorClass: Tensor });

  let inputs: Record<string, unknown>;
  let effectivePastKeyValues: unknown = null;
  if (continuation !== undefined) {
    inputs = continuation.inputs;
    effectivePastKeyValues = continuation.pastKeyValues;
    emitGptOssInputPrepared({
      onInputPrepared,
      prepare: () => ({
        fullConversationInputs: fullInputs,
        cacheDecision: { status: 'reused', reason: 'gpt-oss-owned-tool-continuation' },
      }),
    });
  } else {
    effectivePastKeyValues = null;
    inputs = fullInputs;
    emitGptOssInputPrepared({
      onInputPrepared,
      prepare: () => ({
        fullConversationInputs: inputs,
        cacheDecision: isContinuation
          ? { status: 'not-reused', reason: 'gpt-oss-owned-continuation-unavailable' }
          : { status: 'not-reused', reason: 'gpt-oss-not-tool-continuation' },
      }),
    });
  }

  let currentChannel = '';
  let emittedContent = '';
  const emitChunk = ({ chunk }: { chunk: string }) => {
    emittedContent += chunk; onChunk({ chunk });
  };
  let pendingAnalysisClose = false;
  const parser = new GptOssHarmonyStreamParser();
  const pendingToolCalls: ToolCall[] = [];
  const structured = onGenerationEvent === undefined ? undefined : createGptOssGeneration({
    emit: ({ event }) => {
      onGenerationEvent({ event });
      switch (event.type) {
      case 'tool_call': stoppingCriteria.interrupt(); break;
      case 'part_start': case 'text_delta': case 'part_end': case 'tool_start': case 'result': break;
      default: { const exhaustive: never = event; throw new Error(`Unhandled generation event: ${exhaustive}`); }
      }
    },
  });
  const streamer = structured === undefined ? new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function: (output: string) => {
      const delta = parser.push({ token: output });
      if (!delta) return;

      switch (delta.type) {
      case 'content': {
        const message = parser.messages[delta.messageIndex];
        const channel = message?.channel || '';
        const isFunctionCallMessage = message?.recipient?.startsWith('functions.') === true;
        const visibleChannel = isFunctionCallMessage ? '' : channel;

        if (pendingAnalysisClose) {
          if (visibleChannel !== 'analysis') {
            emitChunk({ chunk: '</think>' });
            currentChannel = '';
          }
          pendingAnalysisClose = false;
        }

        if (visibleChannel !== currentChannel) {
          if (currentChannel === 'analysis') emitChunk({ chunk: '</think>' });
          if (visibleChannel === 'analysis') emitChunk({ chunk: '<think>' });
          currentChannel = visibleChannel;
        }

        if (!isFunctionCallMessage && visibleChannel !== 'commentary') {
          emitChunk({ chunk: delta.textDelta });
        }
        break;
      }
      case 'done': {
        const message = parser.messages[delta.messageIndex];
        const isFunctionCallMessage = message?.recipient?.startsWith('functions.') === true;
        if (!isFunctionCallMessage && currentChannel === 'analysis') {
          pendingAnalysisClose = true;
        }
        switch (delta.endReason) {
        case 'call':
        case 'return':
          if (pendingAnalysisClose || currentChannel === 'analysis') {
            emitChunk({ chunk: '</think>' });
            pendingAnalysisClose = false;
          }
          currentChannel = '';
          break;
        case 'end':
          if (isFunctionCallMessage && currentChannel === 'analysis') {
            emitChunk({ chunk: '</think>' });
            pendingAnalysisClose = false;
            currentChannel = '';
          }
          break;
        default: {
          const exhaustive: never = delta.endReason;
          throw new Error(`Unhandled endReason: ${exhaustive}`);
        }
        }
        switch (delta.endReason) {
        case 'call':
          stoppingCriteria.interrupt();
          if (message?.recipient?.startsWith('functions.')) {
            const functionName = message.recipient.slice('functions.'.length);
            const parsedArgs = tryParseGptOssToolArguments({ content: message.content });
            if (!parsedArgs) {
              break;
            }
            pendingToolCalls.push({
              id: generateId<ToolCallId>(),
              type: 'function',
              function: {
                name: functionName,
                // Preserve the generated JSON spelling, including whitespace and
                // escapes. Validation must not rewrite the stored call arguments.
                arguments: message.content,
              },
            });
          }
          break;
        case 'end':
        case 'return':
          break;
        default: {
          const exhaustive: never = delta.endReason;
          throw new Error(`Unhandled endReason: ${exhaustive}`);
        }
        }
        break;
      }
      case 'new_message':
        break;
      default: {
        const exhaustive: never = delta;
        throw new Error(`Unhandled Harmony delta: ${exhaustive}`);
      }
      }
    },
  }) : new NativeProtocolStreamer({ protocolTokens: undefined, tokenizer,
    onText: ({ text }) => structured.text({ text }),
    onControl: ({ token }) => structured.control({ token }),
  });

  const result = await generateWithModel({
    model,
    inputs,
    pastKeyValues: effectivePastKeyValues,
    params,
    streamer,
    stoppingCriteria,
  });
  if (structured !== undefined) {
    // Absence of a native terminator is not success, even when generate() fulfilled.
    structured.finish({ reason: 'unknown' });
    const assistant = structured.assistant();
    if (assistant === undefined) return undefined;
    return retainGptOssContinuation({ owner: continuationOwner, model, config: model.config, messages,
      assistant, baseInputs: fullInputs, inputs, sequences: result.sequences,
      pastKeyValues: result.past_key_values, tensorClass: Tensor });
  }
  if (pendingToolCalls.length > 0) onToolCalls({ toolCalls: pendingToolCalls });
  return retainGptOssContinuation({ owner: continuationOwner, model, config: model.config, messages,
    assistant: { role: 'assistant', content: emittedContent, tool_calls: pendingToolCalls },
    baseInputs: fullInputs, inputs, sequences: result.sequences, pastKeyValues: result.past_key_values, tensorClass: Tensor });
}

function buildGptOssFullConversationInputs({
  messages,
  tools,
  tokenizer,
}: {
  messages: InferenceMessage[],
  tools: WorkerToolDefinition[] | undefined,
  tokenizer: PreTrainedTokenizer,
}): Record<string, unknown> {
  const formattedMessages = buildGptOssPromptMessages({ messages, tools });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return tokenizer.apply_chat_template(formattedMessages as any, {
    add_generation_prompt: true,
    return_dict: true,
  }) as Record<string, unknown>;
}

function buildGptOssToolResultTokens({
  messages,
  tokenizer,
}: {
  messages: InferenceMessage[],
  tokenizer: PreTrainedTokenizer,
}): Record<string, unknown> {
  const idToName = new Map<ToolCallId, string>();
  for (const message of messages) {
    if (!message.tool_calls) continue;
    for (const toolCall of message.tool_calls) {
      idToName.set(toolCall.id, toolCall.function.name);
    }
  }

  const harmonyText = messages.filter(message => message.tool_call_id).map(message => {
    const functionName = idToName.get(message.tool_call_id!) ?? 'tool';
    const content = readGptOssTextContent({ content: message.content });
    return `<|start|>${functionName} to=assistant<|channel|>commentary<|message|>${content}<|end|>`;
  }).join('');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tokenizer as any)(harmonyText, { add_special_tokens: false });
}

function isGptOssToolContinuationRequest({ messages }: { messages: InferenceMessage[] }): boolean {
  return isToolContinuationRequest({ messages });
}

function isToolContinuationRequest({ messages }: { messages: InferenceMessage[] }): boolean {
  if (messages.length < 2) return false;

  let assistantIndex = messages.length - 1;
  while (assistantIndex >= 0 && messages[assistantIndex]?.tool_call_id) {
    assistantIndex -= 1;
  }

  if (assistantIndex === messages.length - 1) return false;

  const assistantMessage = messages[assistantIndex];
  if (!assistantMessage || assistantMessage.role !== 'assistant' || !assistantMessage.tool_calls?.length) {
    return false;
  }

  const knownToolCallIds = new Set(assistantMessage.tool_calls.map(toolCall => toolCall.id));
  for (let index = assistantIndex + 1; index < messages.length; index += 1) {
    const toolMessage = messages[index];
    if (!toolMessage?.tool_call_id || !knownToolCallIds.has(toolMessage.tool_call_id)) {
      return false;
    }
  }
  return true;
}

function tryParseGptOssToolArguments({
  content,
}: {
  content: string,
}): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  buildGptOssToolResultTokens,
};
