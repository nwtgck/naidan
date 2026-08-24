import type { ChatMessage, LmParameters } from '@/01-models/types';
import type { ToolCallId } from '@/01-models/ids';
import type { Tool, ToolExecutionEvent, ToolExecutionOutcome } from '@/01-models/tool';
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
    onToolCall?: ({ id, toolName, modelVisibleArguments }: {
      id: ToolCallId,
      toolName: string,
      /**
       * Arguments as represented in the LM-visible transcript.
       * Execution-time validation/defaults/transforms must not rewrite this historical call.
       */
      modelVisibleArguments: string,
    }) => void,
    onToolEvent?: ({ id, event }: { id: ToolCallId, event: ToolExecutionEvent }) => void,
    onToolResult?: ({ id, result }: {
      id: ToolCallId,
      result: ToolExecutionOutcome,
    }) => void,
    onAssistantMessageStart?: () => void,
    signal?: AbortSignal,
  }): Promise<void>,

  listModels({ signal }: { signal?: AbortSignal }): Promise<string[]>,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
