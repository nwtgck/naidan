/* eslint-disable no-restricted-imports -- Worker-only GPT-OSS helper intentionally depends on transformers.js stream primitives. */
import {
  TextStreamer,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from '@huggingface/transformers';
import type { ChatMessage, LmParameters, ToolCall } from '@/models/types';
import { HarmonyStreamParser as GptOssHarmonyStreamParser } from '@/utils/gpt-oss-harmony';
import type { WorkerToolDefinition } from './transformers-js.types';

interface GenerationResult {
  past_key_values: unknown;
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
  stoppingCriteria,
  generateWithModel,
}: {
  model: PreTrainedModel;
  tokenizer: PreTrainedTokenizer;
  messages: ChatMessage[];
  onChunk: (chunk: string) => void;
  onToolCalls: (toolCalls: ToolCall[]) => void;
  params: LmParameters | undefined;
  tools: WorkerToolDefinition[] | undefined;
  pastKeyValues: unknown;
  stoppingCriteria: {
    reset(): void;
    interrupt(): void;
  };
  generateWithModel: (args: {
    model: PreTrainedModel;
    inputs: Record<string, unknown>;
    pastKeyValues: unknown;
    params: LmParameters | undefined;
    streamer: TextStreamer;
    stoppingCriteria: {
      reset(): void;
      interrupt(): void;
    };
  }) => Promise<GenerationResult>;
}): Promise<unknown> {
  const isContinuation = isGptOssToolContinuationRequest({ messages });

  let inputs: Record<string, unknown>;
  let effectivePastKeyValues = pastKeyValues;
  if (isContinuation && pastKeyValues !== null) {
    inputs = buildGptOssToolResultTokens({ messages, tokenizer });
  } else {
    effectivePastKeyValues = null;
    const formattedMessages = buildGptOssPromptMessages({ messages, tools });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputs = tokenizer.apply_chat_template(formattedMessages as any, {
      add_generation_prompt: true,
      return_dict: true,
    }) as Record<string, unknown>;
  }

  let currentChannel = '';
  let pendingAnalysisClose = false;
  const parser = new GptOssHarmonyStreamParser();
  const pendingToolCalls: ToolCall[] = [];
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function: (output: string) => {
      const delta = parser.push(output);
      if (!delta) return;

      switch (delta.type) {
      case 'content': {
        const message = parser.messages[delta.messageIndex];
        const channel = message?.channel || '';
        const isFunctionCallMessage = message?.recipient?.startsWith('functions.') === true;
        const visibleChannel = isFunctionCallMessage ? '' : channel;

        if (pendingAnalysisClose) {
          if (visibleChannel !== 'analysis') {
            onChunk('</think>');
            currentChannel = '';
          }
          pendingAnalysisClose = false;
        }

        if (visibleChannel !== currentChannel) {
          if (currentChannel === 'analysis') onChunk('</think>');
          if (visibleChannel === 'analysis') onChunk('<think>');
          currentChannel = visibleChannel;
        }

        if (!isFunctionCallMessage && visibleChannel !== 'commentary') {
          onChunk(delta.textDelta);
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
            onChunk('</think>');
            pendingAnalysisClose = false;
          }
          currentChannel = '';
          break;
        case 'end':
          if (isFunctionCallMessage && currentChannel === 'analysis') {
            onChunk('</think>');
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
              id: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
              type: 'function',
              function: {
                name: functionName,
                arguments: JSON.stringify(parsedArgs),
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
  });

  const result = await generateWithModel({
    model,
    inputs,
    pastKeyValues: effectivePastKeyValues,
    params,
    streamer,
    stoppingCriteria,
  });
  if (pendingToolCalls.length > 0) onToolCalls(pendingToolCalls);
  return result.past_key_values;
}

function jsonSchemaToTsType({ schema }: { schema: Record<string, unknown> }): string {
  const type = schema['type'];
  if (type === 'object') {
    const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
    const required = schema['required'] as string[] | undefined;
    if (!properties || Object.keys(properties).length === 0) return '{}';
    const fields = Object.entries(properties).map(([key, prop]) => {
      const isRequired = required?.includes(key) ?? false;
      return `  ${key}${isRequired ? '' : '?'}: ${jsonSchemaToTsType({ schema: prop })},`;
    });
    return `{\n${fields.join('\n')}\n}`;
  }
  if (type === 'string') return 'string';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'array') {
    const items = schema['items'] as Record<string, unknown> | undefined;
    return items ? `${jsonSchemaToTsType({ schema: items })}[]` : 'unknown[]';
  }
  return 'unknown';
}

function formatGptOssToolDefinitions({ tools }: { tools: WorkerToolDefinition[] }): string {
  const functions = tools.map(tool => {
    const parameterType = jsonSchemaToTsType({ schema: tool.function.parameters });
    return `// ${tool.function.description}\ntype ${tool.function.name} = (_: ${parameterType}) => any;`;
  }).join('\n\n');
  return `namespace functions {\n${functions}\n\n} // namespace functions`;
}

function buildGptOssToolResultTokens({
  messages,
  tokenizer,
}: {
  messages: ChatMessage[];
  tokenizer: PreTrainedTokenizer;
}): Record<string, unknown> {
  const idToName = new Map<string, string>();
  for (const message of messages) {
    if (!message.tool_calls) continue;
    for (const toolCall of message.tool_calls) {
      idToName.set(toolCall.id, toolCall.function.name);
    }
  }

  const harmonyText = messages.filter(message => message.tool_call_id).map(message => {
    const functionName = idToName.get(message.tool_call_id!) ?? 'tool';
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    return `<|start|>${functionName} to=assistant<|channel|>commentary<|message|>${content}<|end|>`;
  }).join('');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tokenizer as any)(harmonyText, { add_special_tokens: false });
}

function isGptOssToolContinuationRequest({ messages }: { messages: ChatMessage[] }): boolean {
  return isToolContinuationRequest({ messages });
}

function isToolContinuationRequest({ messages }: { messages: ChatMessage[] }): boolean {
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

function buildGptOssPromptMessages({
  messages,
  tools,
}: {
  messages: ChatMessage[];
  tools: WorkerToolDefinition[] | undefined;
}): Array<{
  role: string;
  content: string;
  tool_calls: ChatMessage['tool_calls'];
  tool_call_id: string | undefined;
}> {
  const formattedMessages = messages.map(message => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    tool_calls: message.tool_calls,
    tool_call_id: message.tool_call_id,
  }));

  // Keep gpt-oss close to the last known-good naidan path: pass the user's
  // existing conversation through with minimal reshaping, and only prepend the
  // TypeScript namespace tool definitions that gpt-oss expects.
  // We intentionally do not synthesize Harmony system/developer scaffolding
  // here because that changed prompt semantics and caused UX regressions.
  if (tools && tools.length > 0) {
    formattedMessages.unshift({
      role: 'developer',
      content: formatGptOssToolDefinitions({ tools }),
      tool_calls: undefined,
      tool_call_id: undefined,
    });
  }

  return formattedMessages.map(message => ({
    role: message.role,
    content: message.content,
    tool_calls: message.tool_calls,
    tool_call_id: message.tool_call_id,
  }));
}

function tryParseGptOssToolArguments({
  content,
}: {
  content: string;
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
