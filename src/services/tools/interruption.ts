import type { ToolCallId } from '@/models/ids';
import type { ToolExecutionResult } from '@/services/tools/types';

export const TOOL_EXECUTION_INTERRUPTED_MESSAGE = 'Tool execution was interrupted before completion.';

export function markExecutingToolResultsAsInterrupted({
  results,
  toolCallIds,
}: {
  results: ToolExecutionResult[];
  toolCallIds: ReadonlySet<ToolCallId>;
}): number {
  let interruptedCount = 0;

  for (const [index, result] of results.entries()) {
    if (result.status !== 'executing' || !toolCallIds.has(result.toolCallId)) {
      continue;
    }

    results[index] = {
      toolCallId: result.toolCallId,
      status: 'error',
      error: {
        code: 'other',
        message: {
          type: 'text',
          text: TOOL_EXECUTION_INTERRUPTED_MESSAGE,
        },
      },
    };
    interruptedCount += 1;
  }

  return interruptedCount;
}
