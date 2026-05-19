import type { ChatMessage, LmParameters } from '@/models/types';
import type { LLMProvider } from '@/services/lm/types';
import type { Tool } from '@/services/tools/types';

function createUnsupportedError(): Error {
  return new Error('Transformers.js is not available in standalone mode');
}

export class TransformersJsProvider implements LLMProvider {
  async chat(_params: {
    messages: ChatMessage[];
    model: string;
    onChunk: (chunk: string) => void;
    parameters?: LmParameters;
    tools?: Tool[];
    onToolCall?: (params: { id: string; toolName: string; args: unknown }) => void;
    onToolEvent?: (params: { id: string; event: import('../tools/types').ToolExecutionEvent }) => void;
    onToolResult?: (params: {
      id: string;
      result: | { status: 'success'; content: string } | { status: 'error'; code: import('../tools/types').ToolExecutionErrorCode; message: string };
    }) => void;
    onAssistantMessageStart?: () => void;
    signal?: AbortSignal;
  }): Promise<void> {
    throw createUnsupportedError();
  }

  async listModels(_params: { signal?: AbortSignal }): Promise<string[]> {
    return [];
  }
}
