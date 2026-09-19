import type { ChatMessage, LmParameters, MultimodalContent, ToolCall } from '@/01-models/types';
import { exactObject } from '@/utils/exact-object';
import type { WorkerToolDefinition, WorkerToolJsonObject } from './types';

export function cloneLmParameters({ params }: { params: LmParameters | undefined }): LmParameters | undefined {
  if (!params) return undefined;

  return {
    temperature: params.temperature,
    topP: params.topP,
    maxCompletionTokens: params.maxCompletionTokens,
    presencePenalty: params.presencePenalty,
    frequencyPenalty: params.frequencyPenalty,
    stop: params.stop ? [...params.stop] : undefined,
    reasoning: {
      effort: params.reasoning?.effort,
    },
  };
}

function cloneToolCalls({ toolCalls }: { toolCalls: ToolCall[] | undefined }): ToolCall[] | undefined {
  if (!toolCalls) return undefined;

  return toolCalls.map(toolCall => ({
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  }));
}

export function cloneChatMessages({ messages }: { messages: ChatMessage[] }): ChatMessage[] {
  return messages.map(message => {
    const { role, content, tool_calls, tool_call_id, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    // This is a detached native-template input, not a lossless JavaScript
    // object clone. Undefined optional tool fields mean absence; creating
    // their keys can select a template's tool-call branch. Keep empty lists.
    return exactObject<ChatMessage>()({
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

