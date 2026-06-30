import type { ToolCallId } from '@/01-models/ids';
import type { ToolExecutionResult } from '@/01-models/tool';

const TOOL_EXECUTION_INTERRUPTED_MESSAGE = 'Tool execution was interrupted before completion.';

export function markExecutingToolResultsAsInterrupted({
  results,
  toolCallIds,
}: {
  results: ToolExecutionResult[],
  toolCallIds: ReadonlySet<ToolCallId>,
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  TOOL_EXECUTION_INTERRUPTED_MESSAGE,
};
