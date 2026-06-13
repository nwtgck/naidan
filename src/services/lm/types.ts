import type { ChatMessage, LmParameters } from '@/models/types';
import type { Tool, ToolExecutionEvent } from '@/services/tools/types';
import type { ToolApprovalContext } from '@/services/approval';

export const UNKNOWN_STEPS: unique symbol = Symbol('unknown');

export interface LLMProvider {
  chat({ messages, model, onChunk, parameters, tools, toolApprovalContext, onToolCall, onToolEvent, onToolResult, onAssistantMessageStart, signal }: {
    messages: ChatMessage[];
    model: string;
    onChunk: ({ chunk }: { chunk: string }) => void;
    parameters?: LmParameters;
    tools?: Tool[];
    toolApprovalContext?: ToolApprovalContext;
    onToolCall?: ({ id, toolName, args }: { id: string; toolName: string; args: unknown }) => void;
    onToolEvent?: ({ id, event }: { id: string; event: ToolExecutionEvent }) => void;
    onToolResult?: ({ id, result }: {
      id: string;
      result: | { status: 'success'; content: string } | { status: 'error'; code: import('../tools/types').ToolExecutionErrorCode; message: string };
    }) => void;
    onAssistantMessageStart?: () => void;
    signal?: AbortSignal;
  }): Promise<void>;

  listModels({ signal }: { signal?: AbortSignal }): Promise<string[]>;
}
