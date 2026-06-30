import type { ChatMessage, LmParameters } from '@/01-models/types';
import type { ToolCallId } from '@/01-models/ids';
import type { LmProvider } from '@/01-models/lm';
import type { Tool } from '@/01-models/tool';

function createUnsupportedError(): Error {
  return new Error('Transformers.js is not available in standalone mode');
}

export class TransformersJsProvider implements LmProvider {
  async chat({ messages: _messages, model: _model, onChunk: _onChunk, parameters: _parameters, tools: _tools, onToolCall: _onToolCall, onToolEvent: _onToolEvent, onToolResult: _onToolResult, onAssistantMessageStart: _onAssistantMessageStart, signal: _signal }: {
    messages: ChatMessage[],
    model: string,
    onChunk: ({ chunk }: { chunk: string }) => void,
    parameters?: LmParameters,
    tools?: Tool[],
    onToolCall?: ({ id, toolName, args }: { id: ToolCallId, toolName: string, args: unknown }) => void,
    onToolEvent?: ({ id, event }: { id: ToolCallId, event: import('@/01-models/tool').ToolExecutionEvent }) => void,
    onToolResult?: ({ id, result }: {
      id: ToolCallId,
      result: | { status: 'success', content: string } | { status: 'error', code: import('@/01-models/tool').ToolExecutionErrorCode, message: string },
    }) => void,
    onAssistantMessageStart?: () => void,
    signal?: AbortSignal,
  }): Promise<void> {
    throw createUnsupportedError();
  }

  async listModels({ signal: _signal }: { signal?: AbortSignal }): Promise<string[]> {
    return [];
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
