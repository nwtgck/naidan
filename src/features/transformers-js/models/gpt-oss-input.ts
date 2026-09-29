import type { InferenceMessage, WorkerToolDefinition } from '@/features/transformers-js/types';
import { idToRaw } from '@/01-models/ids';
import { exactObject } from '@/utils/exact-object';
import { readCompleteInferenceReasoning } from '@/features/transformers-js/inference-reasoning';

// Native input projection is independent of the model/streamer runtime.
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

export function buildGptOssPromptMessages({
  messages,
  tools,
}: {
  messages: InferenceMessage[],
  tools: WorkerToolDefinition[] | undefined,
}): Array<{
  role: string,
  content: string,
  tool_calls?: InferenceMessage['tool_calls'],
  tool_call_id?: string,
  thinking?: string,
}> {
  const formattedMessages = messages.map(message => {
    const { role, content, tool_calls, tool_call_id, reasoning: _reasoning, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    const thinking = readCompleteInferenceReasoning({ message });
    const body = readGptOssTextContent({ content });
    // The supplied native template uses one analysis body before a tool call;
    // it cannot express a second assistant text body at that same position.
    if (thinking !== undefined && body.length > 0 && tool_calls?.length) {
      throw new Error('GPT-OSS cannot preserve both structured reasoning and text before a tool call.');
    }
    // The native template checks key membership, so an absent optional field
    // must not become an own undefined property while formatting history.
    return exactObject<{ role: string; content: string; tool_calls?: InferenceMessage['tool_calls']; tool_call_id?: string; thinking?: string }>()({
      role,
      content: body,
      ...(tool_calls === undefined ? {} : { tool_calls }),
      ...(tool_call_id === undefined ? {} : { tool_call_id: idToRaw({ id: tool_call_id }) }),
      ...(thinking === undefined ? {} : { thinking }),
    });
  });

  // Keep gpt-oss close to the last known-good naidan path: pass the user's
  // existing conversation through with minimal reshaping, and only prepend the
  // TypeScript namespace tool definitions that gpt-oss expects.
  // We intentionally do not synthesize Harmony system/developer scaffolding
  // here because that changed prompt semantics and caused UX regressions.
  if (tools && tools.length > 0) {
    formattedMessages.unshift({
      role: 'developer',
      content: formatGptOssToolDefinitions({ tools }),
    });
  }

  return formattedMessages;
}

export function readGptOssTextContent({ content }: { content: InferenceMessage['content'] }): string {
  if (typeof content === 'string') return content;
  // Harmony messages have a text body. Join only at this native boundary,
  // without separators or trimming; never turn an unsupported image into silence.
  let body = '';
  for (const part of content) {
    switch (part.type) {
    case 'text': {
      const { type: _type, text, ...unhandled } = part;
      unhandled satisfies Record<PropertyKey, never>;
      body += text;
      break;
    }
    case 'image_url': throw new Error('GPT-OSS input is text-only; image content cannot be omitted.');
    default: {
      const exhaustive: never = part;
      throw new Error(`Unhandled GPT-OSS content: ${exhaustive}`);
    }
    }
  }
  return body;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
