import type { LmParameters, MultimodalContent, ToolCall } from '@/01-models/types';
import type { InferenceMessage } from '@/features/transformers-js/types';
import { exactObject } from '@/utils/exact-object';
import type { WorkerToolDefinition, WorkerToolJsonObject } from './types';

export function cloneLmParameters({ params }: { params: LmParameters | undefined }): LmParameters | undefined {
  if (!params) return undefined;
  const { temperature, topP, maxCompletionTokens, presencePenalty, frequencyPenalty, stop, reasoning, ...unhandled } = params;
  unhandled satisfies Record<PropertyKey, never>;
  if (reasoning !== undefined) {
    const { effort: _effort, ...unhandledReasoning } = reasoning;
    unhandledReasoning satisfies Record<PropertyKey, never>;
  }

  return {
    temperature,
    topP,
    maxCompletionTokens,
    presencePenalty,
    frequencyPenalty,
    stop: stop ? [...stop] : undefined,
    reasoning: {
      effort: reasoning?.effort,
    },
  };
}

function cloneToolCalls({ toolCalls }: { toolCalls: ToolCall[] | undefined }): ToolCall[] | undefined {
  if (!toolCalls) return undefined;

  return toolCalls.map(toolCall => {
    const { id, type, function: fn, ...unhandled } = toolCall;
    unhandled satisfies Record<PropertyKey, never>;
    const { name, arguments: args, ...unhandledFunction } = fn;
    unhandledFunction satisfies Record<PropertyKey, never>;
    return exactObject<ToolCall>()({ id, type, function: exactObject<ToolCall['function']>()({ name, arguments: args }) });
  });
}

export function cloneChatMessages({ messages }: { messages: readonly InferenceMessage[] }): InferenceMessage[] {
  return messages.map(message => {
    const { role, content, tool_calls, tool_call_id, reasoning, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    // This is a detached native-template input, not a lossless JavaScript
    // object clone. Undefined optional tool fields mean absence; creating
    // their keys can select a template's tool-call branch. Keep empty lists.
    return exactObject<InferenceMessage>()({
      role,
      content: Array.isArray(content)
        ? content.map((part): MultimodalContent => {
          switch (part.type) {
          case 'text': {
            const { type, text, ...unhandledPart } = part;
            unhandledPart satisfies Record<PropertyKey, never>;
            return exactObject<Extract<MultimodalContent, { type: 'text' }>>()({ type, text });
          }
          case 'image_url': {
            const { type, image_url, ...unhandledPart } = part;
            unhandledPart satisfies Record<PropertyKey, never>;
            const { url, ...unhandledImage } = image_url;
            unhandledImage satisfies Record<PropertyKey, never>;
            return exactObject<Extract<MultimodalContent, { type: 'image_url' }>>()({
              type, image_url: exactObject<Extract<MultimodalContent, { type: 'image_url' }>['image_url']>()({ url }),
            });
          }
          default: {
            const _ex: never = part;
            return _ex;
          }
          }
        })
        : content,
      ...(tool_calls === undefined ? {} : { tool_calls: cloneToolCalls({ toolCalls: tool_calls }) }),
      ...(tool_call_id === undefined ? {} : { tool_call_id }),
      ...(reasoning === undefined ? {} : { reasoning: (() => {
        const { text, completeness, ...unhandledReasoning } = reasoning;
        unhandledReasoning satisfies Record<PropertyKey, never>;
        return { text, completeness };
      })() }),
    });
  });
}

export function cloneWorkerTools({ tools }: { tools: WorkerToolDefinition[] | undefined }): WorkerToolDefinition[] | undefined {
  if (!tools) return undefined;

  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: JSON.parse(JSON.stringify(tool.function.parameters)) as WorkerToolJsonObject,
    },
  }));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};

