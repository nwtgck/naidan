import type { ChatMessage, LmParameters } from '@/models/types';
import type { Tool, ToolExecutionEvent } from '@/services/tools/types';

export const UNKNOWN_STEPS: unique symbol = Symbol('unknown');

export interface LLMProvider {
  chat(params: {
    messages: ChatMessage[];
    model: string;
    onChunk: (chunk: string) => void;
    parameters?: LmParameters;
    tools?: Tool[];
    onToolCall?: (params: { id: string; toolName: string; args: unknown }) => void;
    onToolEvent?: (params: { id: string; event: ToolExecutionEvent }) => void;
    onToolResult?: (params: {
      id: string;
      result: | { status: 'success'; content: string } | { status: 'error'; code: import('../tools/types').ToolExecutionErrorCode; message: string };
    }) => void;
    onAssistantMessageStart?: () => void;
    signal?: AbortSignal;
  }): Promise<void>;

  listModels(params: { signal?: AbortSignal }): Promise<string[]>;
}
