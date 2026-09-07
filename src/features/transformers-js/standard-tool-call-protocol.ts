/* eslint-disable no-restricted-imports -- Worker-only protocol detection intentionally depends on transformers.js tokenizer types. */
import type { PreTrainedTokenizer } from '@huggingface/transformers';
import type { ChatMessage, ToolCall } from '@/01-models/types';
import type { WorkerToolDefinition } from './types';
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
