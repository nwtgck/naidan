import type { ChatMessage, LmParameters } from '@/models/types';
import type { LLMProvider } from '@/services/lm/types';
import type { Tool } from '@/services/tools/types';

function createUnsupportedError(): Error {
  return new Error('Transformers.js is not available in standalone mode');
}

export class TransformersJsProvider implements LLMProvider {
  async chat({ messages: _messages, model: _model, onChunk: _onChunk, parameters: _parameters, tools: _tools, onToolCall: _onToolCall, onToolEvent: _onToolEvent, onToolResult: _onToolResult, onAssistantMessageStart: _onAssistantMessageStart, signal: _signal }: {
    messages: ChatMessage[];
    model: string;
    onChunk: ({ chunk }: { chunk: string }) => void;
    parameters?: LmParameters;
    tools?: Tool[];
    onToolCall?: ({ id, toolName, args }: { id: string; toolName: string; args: unknown }) => void;
    onToolEvent?: ({ id, event }: { id: string; event: import('../tools/types').ToolExecutionEvent }) => void;
    onToolResult?: ({ id, result }: {
      id: string;
      result: | { status: 'success'; content: string } | { status: 'error'; code: import('../tools/types').ToolExecutionErrorCode; message: string };
    }) => void;
    onAssistantMessageStart?: () => void;
    signal?: AbortSignal;
  }): Promise<void> {
    throw createUnsupportedError();
  }

  async listModels({ signal: _signal }: { signal?: AbortSignal }): Promise<string[]> {
    return [];
  }
}
