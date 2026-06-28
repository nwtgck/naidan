import type { ChatMessage, LmParameters } from '@/01-models/types';
import type { ToolCallId } from '@/01-models/ids';
import type { Tool, ToolExecutionEvent } from '@/01-models/tool';
import type { ToolApprovalContext } from '@/01-models/tool-approval';

export const UNKNOWN_STEPS: unique symbol = Symbol('unknown');

export interface LmProvider {
  chat({ messages, model, onChunk, parameters, tools, toolApprovalContext, onToolCall, onToolEvent, onToolResult, onAssistantMessageStart, signal }: {
    messages: ChatMessage[],
    model: string,
    onChunk: ({ chunk }: { chunk: string }) => void,
    parameters?: LmParameters,
    tools?: Tool[],
    toolApprovalContext?: ToolApprovalContext,
    onToolCall?: ({ id, toolName, args }: { id: ToolCallId, toolName: string, args: unknown }) => void,
    onToolEvent?: ({ id, event }: { id: ToolCallId, event: ToolExecutionEvent }) => void,
    onToolResult?: ({ id, result }: {
      id: ToolCallId,
      result: | { status: 'success', content: string } | { status: 'error', code: import('@/01-models/tool').ToolExecutionErrorCode, message: string },
    }) => void,
    onAssistantMessageStart?: () => void,
    signal?: AbortSignal,
  }): Promise<void>,

  listModels({ signal }: { signal?: AbortSignal }): Promise<string[]>,
}
