/* eslint-disable no-restricted-imports -- Worker-only protocol detection intentionally depends on transformers.js tokenizer types. */
import type { PreTrainedTokenizer } from '@huggingface/transformers';
import type { ChatMessage, ToolCall } from '@/01-models/types';
import type { WorkerToolDefinition } from './types';
import { z } from 'zod';
import { ToolCallStreamParser } from './tool-call-parser';
import {
  DELIMITED_PYTHONIC_TOOL_CALL_CLOSE,
  DELIMITED_PYTHONIC_TOOL_CALL_OPEN,
  DelimitedPythonicToolCallStreamParser,
  parseDelimitedPythonicToolCallPayload,
} from './delimited-pythonic-tool-call-parser';

export type StandardToolCallProtocol =
  | 'json-tagged'
  | 'delimited-pythonic';

interface StandardToolCallStreamParser {
  feed({ output }: { output: string }): void,
  flush(): void,
  drainToolCalls(): ToolCall[],
}

const detectedProtocolByTokenizer = new WeakMap<object, StandardToolCallProtocol>();
export type StandardToolHandling = {
  outputProtocol: StandardToolCallProtocol;
  historyEncoding: 'native-template' | 'verified-content';
  preservedDelimiterIds: readonly number[];
};
const handlingByTokenizer = new WeakMap<object, StandardToolHandling>();
const PROBE_TOOL_NAME = '__naidan_tool_protocol_probe__';
const PROBE_ARGUMENT_NAME = 'value';
const PROBE_ARGUMENT_VALUE = '__naidan_tool_protocol_probe_value__';
const PROBE_TOOL_CALL_ID = '__naidan_tool_protocol_probe_call__';
const PROBE_RESULT_VALUE = '__naidan_tool_protocol_probe_result__';

const PROBE_TOOL: WorkerToolDefinition = {
  type: 'function',
  function: {
    name: PROBE_TOOL_NAME,
    description: 'Naidan internal chat-template protocol probe.',
    parameters: {
      type: 'object',
      properties: {
        [PROBE_ARGUMENT_NAME]: { type: 'string' },
      },
      required: [PROBE_ARGUMENT_NAME],
    },
  },
};

const PROBE_MESSAGES = [
  {
    role: 'user',
    content: '__naidan_tool_protocol_probe_user_message__',
  },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: PROBE_TOOL_CALL_ID,
        type: 'function',
        function: {
          name: PROBE_TOOL_NAME,
          arguments: {
            [PROBE_ARGUMENT_NAME]: PROBE_ARGUMENT_VALUE,
          },
        },
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: PROBE_TOOL_CALL_ID,
    content: PROBE_RESULT_VALUE,
  },
];

/**
 * Observe the tokenizer's tool-call wire format without running the model.
 * The synthetic turn is rendered only through apply_chat_template(tokenize=false),
 * includes a tool result plus the next generation prompt, and is cached per tokenizer.
 */
export function detectStandardToolCallProtocol({
  tokenizer,
  debugLog,
}: {
  tokenizer: PreTrainedTokenizer,
  debugLog: ({ event, details }: { event: string, details: Record<string, unknown> }) => void,
}): StandardToolCallProtocol {
  const cacheKey = tokenizer as object;
  const cached = detectedProtocolByTokenizer.get(cacheKey);
  if (cached) return cached;

  let protocol: StandardToolCallProtocol = 'json-tagged';
  try {
    const rendered = tokenizer.apply_chat_template(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Probe shape intentionally matches Transformers.js chat-template input rather than Naidan ChatMessage.
      PROBE_MESSAGES as any,
      {
        tools: [PROBE_TOOL],
        add_generation_prompt: true,
        tokenize: false,
        return_dict: false,
      },
    );

    if (typeof rendered === 'string' && rendersDelimitedPythonicProbe({ rendered })) {
      protocol = 'delimited-pythonic';
    }
  } catch (error) {
    debugLog({
      event: 'standard tool-call protocol observation unavailable',
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }

  detectedProtocolByTokenizer.set(cacheKey, protocol);
  return protocol;
}

function rendersDelimitedPythonicProbe({ rendered }: { rendered: string }): boolean {
  const startIndex = rendered.indexOf(DELIMITED_PYTHONIC_TOOL_CALL_OPEN);
  if (startIndex === -1) return false;
  const contentStart = startIndex + DELIMITED_PYTHONIC_TOOL_CALL_OPEN.length;
  const endIndex = rendered.indexOf(DELIMITED_PYTHONIC_TOOL_CALL_CLOSE, contentStart);
  if (endIndex === -1) return false;
  if (rendered.indexOf(DELIMITED_PYTHONIC_TOOL_CALL_OPEN, contentStart) !== -1) return false;

  const parsed = parseDelimitedPythonicToolCallPayload({
    content: rendered.slice(contentStart, endIndex),
  });
  if (parsed?.length !== 1) return false;

  const [call] = parsed;
  if (!call || call.name !== PROBE_TOOL_NAME) return false;
  const argumentKeys = Object.keys(call.arguments);
  if (
    argumentKeys.length !== 1
    || argumentKeys[0] !== PROBE_ARGUMENT_NAME
    || call.arguments[PROBE_ARGUMENT_NAME] !== PROBE_ARGUMENT_VALUE
  ) return false;

  return rendered.indexOf(PROBE_RESULT_VALUE, endIndex + DELIMITED_PYTHONIC_TOOL_CALL_CLOSE.length) !== -1;
}

/** A content route is admitted only for the observed ChatML framing contract.
 * Vocabulary alone does not establish a tool protocol or a history transport.
 */
export function resolveStandardToolHandling({ tokenizer, debugLog }: {
  tokenizer: PreTrainedTokenizer;
  debugLog: ({ event, details }: { event: string; details: Record<string, unknown> }) => void;
}): StandardToolHandling {
  const cached = handlingByTokenizer.get(tokenizer);
  if (cached !== undefined) return cached;
  const outputProtocol = detectStandardToolCallProtocol({ tokenizer, debugLog });
  let handling: StandardToolHandling = { outputProtocol, historyEncoding: 'native-template', preservedDelimiterIds: [] };
  switch (outputProtocol) {
  case 'delimited-pythonic': {
    try {
      const ids = readAtomicDelimiterIds({ tokenizer });
      if (ids.some(id => tokenizer.all_special_ids.includes(id))) handling = { ...handling, preservedDelimiterIds: ids };
    } catch (error) {
      debugLog({ event: 'standard tool delimiter token observation unavailable', details: { error: error instanceof Error ? error.message : String(error) } });
    }
    break;
  }
  case 'json-tagged': {
    try {
      const ids = readAtomicDelimiterIds({ tokenizer });
      if (!ids.every(id => tokenizer.all_special_ids.includes(id))) throw new Error('Unclassified content route lacks special delimiter tokens');
      const render = ({ messages }: { messages: Parameters<PreTrainedTokenizer['apply_chat_template']>[0] }) => {
        const result = tokenizer.apply_chat_template(messages, { tools: [PROBE_TOOL], add_generation_prompt: true, tokenize: false, return_dict: false });
        if (typeof result !== 'string') throw new Error('Non-text protocol probe');
        return result;
      };
      const native = render({ messages: PROBE_MESSAGES });
      const plain = PROBE_MESSAGES.map(({ ...message }) => {
        if (message.role !== 'assistant') return message;
        return { role: 'assistant', content: '' };
      });
      // A positive JSON/native history render is not replaced by a vocabulary hint.
      if (native !== render({ messages: plain })) throw new Error('Native structured tool history is not omitted');
      const placeholder = '__naidan_assistant_content_probe__';
      const withContent = ({ content }: { content: string }) => plain.map(message => message.role === 'assistant' ? { ...message, content } : message);
      const probeFrame = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[${PROBE_TOOL_NAME}(${PROBE_ARGUMENT_NAME}="${PROBE_ARGUMENT_VALUE}")]${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;
      const placeholderRender = render({ messages: withContent({ content: placeholder }) });
      const suffix = `<|im_start|>assistant\n${placeholder}<|im_end|>\n<|im_start|>tool\n${PROBE_RESULT_VALUE}<|im_end|>\n<|im_start|>assistant\n`;
      if (!placeholderRender.endsWith(suffix) || placeholderRender.split(placeholder).length !== 2
        || placeholderRender.replace(placeholder, '') !== native
        || render({ messages: withContent({ content: probeFrame }) }) !== placeholderRender.replace(placeholder, probeFrame)) {
        throw new Error('Template cannot preserve the exact assistant/tool content route');
      }
      handling = { outputProtocol: 'delimited-pythonic', historyEncoding: 'verified-content', preservedDelimiterIds: ids };
    } catch (error) {
      debugLog({ event: 'standard tool content route unavailable', details: { error: error instanceof Error ? error.message : String(error) } });
    }
    break;
  }
  default: { const exhaustive: never = outputProtocol; throw new Error(String(exhaustive)); }
  }
  handlingByTokenizer.set(tokenizer, handling);
  return handling;
}

function readAtomicDelimiterIds({ tokenizer }: { tokenizer: PreTrainedTokenizer }): number[] {
  const ids = [DELIMITED_PYTHONIC_TOOL_CALL_OPEN, DELIMITED_PYTHONIC_TOOL_CALL_CLOSE].map(marker => {
    const encoded = tokenizer.encode(marker, { add_special_tokens: false });
    if (encoded.length !== 1 || !Number.isSafeInteger(encoded[0]) || encoded[0]! < 0 || encoded[0] === tokenizer.unk_token_id
      || tokenizer.decode(encoded, { skip_special_tokens: false }) !== marker) throw new Error('Tool delimiter is not an atomic token');
    return encoded[0]!;
  });
  if (new Set(ids).size !== 2) throw new Error('Tool delimiters share a token ID');
  return ids;
}

/** Reject unsupported content-history work before the Provider executes tools. */
export function validateStandardToolCallsForHandling({ toolCalls, handling, assistantContent }: {
  toolCalls: ToolCall[]; handling: StandardToolHandling; assistantContent: string;
}): void {
  switch (handling.historyEncoding) {
  case 'native-template': return;
  case 'verified-content':
    if (toolCalls.length > 1) throw new Error('Content tool history does not support multiple calls');
    if (toolCalls.length > 0) readContentToolAssistantText({ content: assistantContent });
    for (const call of toolCalls) serializeContentToolCall({ call });
    return;
  default: { const exhaustive: never = handling.historyEncoding; throw new Error(String(exhaustive)); }
  }
}

export function formatStandardMessagesForToolHandling({ messages, handling }: {
  messages: ChatMessage[]; handling: StandardToolHandling;
}): Array<Record<string, unknown>> {
  switch (handling.historyEncoding) {
  case 'native-template': return formatStandardMessagesForToolCallProtocol({ messages, protocol: handling.outputProtocol });
  case 'verified-content': break;
  default: { const exhaustive: never = handling.historyEncoding; throw new Error(String(exhaustive)); }
  }
  const consumedResults = new Set<number>();
  const usedIds = new Set<ToolCall['id']>();
  return messages.map((message, index) => {
    const { role, content, tool_calls, tool_call_id, ...unhandledMessage } = message;
    unhandledMessage satisfies Record<PropertyKey, never>;
    if (role === 'tool' && !consumedResults.has(index)) throw new Error('Unassociated tool result in content history');
    if (tool_calls === undefined || tool_calls.length === 0) {
      return { role, content: typeof content === 'string' ? content : '', tool_call_id };
    }
    const call = tool_calls[0]!;
    const result = messages[index + 1];
    if (role !== 'assistant' || tool_calls.length !== 1 || usedIds.has(call.id)
      || result?.role !== 'tool' || result.tool_call_id !== call.id || typeof result.content !== 'string') {
      throw new Error('Content tool history requires one assistant call and its immediately associated result');
    }
    usedIds.add(call.id);
    consumedResults.add(index + 1);
    const frame = serializeContentToolCall({ call });
    return { role: 'assistant', content: readContentToolAssistantText({ content }) + frame };
  });
}

function readContentToolAssistantText({ content }: { content: unknown }): string {
  if (typeof content !== 'string' || content.includes('<|')) {
    throw new Error('Content tool history requires plain assistant text without control-token prefixes');
  }
  return content;
}

function serializeContentToolCall({ call }: { call: ToolCall }): string {
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/;
  const args = z.record(z.string(), z.json()).parse(parseToolArgumentsObject({ functionName: call.function.name, argumentsJson: call.function.arguments }));
  if (!identifier.test(call.function.name) || Object.keys(args).some(key => !identifier.test(key))) throw new Error('Tool content frame requires identifier names');
  const payload = `[${call.function.name}(${Object.entries(args).map(([key, value]) => `${key}=${JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}`).join(', ')})]`;
  const parsed = parseDelimitedPythonicToolCallPayload({ content: payload });
  if (JSON.stringify(parsed) !== JSON.stringify([{ name: call.function.name, arguments: args }])) throw new Error('Tool content arguments do not roundtrip');
  return `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}${payload}${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;
}

export function formatStandardMessagesForToolCallProtocol({
  messages,
  protocol,
}: {
  messages: ChatMessage[],
  protocol: StandardToolCallProtocol,
}): Array<Record<string, unknown>> {
  return messages.map(message => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    tool_calls: formatToolCallsForProtocol({ toolCalls: message.tool_calls, protocol }),
    tool_call_id: message.tool_call_id,
  }));
}

function formatToolCallsForProtocol({
  toolCalls,
  protocol,
}: {
  toolCalls: ToolCall[] | undefined,
  protocol: StandardToolCallProtocol,
}): unknown {
  if (!toolCalls) return undefined;

  switch (protocol) {
  case 'json-tagged':
    return toolCalls;
  case 'delimited-pythonic':
    return toolCalls.map(toolCall => ({
      id: toolCall.id,
      type: toolCall.type,
      function: {
        name: toolCall.function.name,
        arguments: parseToolArgumentsObject({
          functionName: toolCall.function.name,
          argumentsJson: toolCall.function.arguments,
        }),
      },
    }));
  default: {
    const _ex: never = protocol;
    throw new Error(`Unhandled standard tool-call protocol: ${String(_ex)}`);
  }
  }
}

function parseToolArgumentsObject({
  functionName,
  argumentsJson,
}: {
  functionName: string,
  argumentsJson: string,
}): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch (error) {
    throw new Error(
      `Tool call arguments for "${functionName}" are not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Tool call arguments for "${functionName}" must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function createStandardToolCallStreamParser({
  protocol,
  tools,
  onText,
}: {
  protocol: StandardToolCallProtocol,
  tools: WorkerToolDefinition[],
  onText: ({ text }: { text: string }) => void,
}): StandardToolCallStreamParser {
  switch (protocol) {
  case 'json-tagged':
    return new ToolCallStreamParser({ onText });
  case 'delimited-pythonic':
    return new DelimitedPythonicToolCallStreamParser({
      onText,
      allowedToolNames: new Set(tools.map(tool => tool.function.name)),
    });
  default: {
    const _ex: never = protocol;
    throw new Error(`Unhandled standard tool-call protocol: ${String(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  rendersDelimitedPythonicProbe,
};
