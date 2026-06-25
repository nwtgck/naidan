import type { ChatMessage, LmParameters } from '@/models/types';
import type { ToolCallId } from '@/models/ids';
import type { LmProvider } from '@/services/lm/types';
import type { Tool } from '@/services/tools/types';

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
    onToolEvent?: ({ id, event }: { id: ToolCallId, event: import('@/services/tools/types').ToolExecutionEvent }) => void,
    onToolResult?: ({ id, result }: {
      id: ToolCallId,
      result: | { status: 'success', content: string } | { status: 'error', code: import('@/services/tools/types').ToolExecutionErrorCode, message: string },
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
