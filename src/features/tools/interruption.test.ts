import { describe, expect, it } from 'vitest';
import { toToolCallId } from '@/01-models/ids';
import {
  markExecutingToolResultsAsInterrupted,
  TOOL_EXECUTION_INTERRUPTED_MESSAGE,
} from './interruption';
import type { ToolExecutionResult } from '@/01-models/tool';

describe('markExecutingToolResultsAsInterrupted', () => {
  it('marks only matching executing results as interrupted errors', () => {
    const executingId = toToolCallId({ raw: 'executing' });
    const unrelatedId = toToolCallId({ raw: 'unrelated' });
    const completedId = toToolCallId({ raw: 'completed' });
    const results: ToolExecutionResult[] = [
      { toolCallId: executingId, status: 'executing' },
      { toolCallId: unrelatedId, status: 'executing' },
      {
        toolCallId: completedId,
        status: 'success',
        content: { type: 'text', text: 'done' },
      },
    ];

    expect(markExecutingToolResultsAsInterrupted({
      results,
      toolCallIds: new Set([executingId, completedId]),
    })).toBe(1);

    expect(results).toEqual([
      {
        toolCallId: executingId,
        status: 'error',
        error: {
          code: 'other',
          message: {
            type: 'text',
            text: TOOL_EXECUTION_INTERRUPTED_MESSAGE,
          },
        },
      },
      { toolCallId: unrelatedId, status: 'executing' },
      {
        toolCallId: completedId,
        status: 'success',
        content: { type: 'text', text: 'done' },
      },
    ]);
  });
});
