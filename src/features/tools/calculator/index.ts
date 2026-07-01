import { z } from 'zod';
import type { Tool, ToolExecutionErrorCode, ToolExecutionEvent } from '@/01-models/tool';
import {
  CALCULATOR_MAX_INPUT_LENGTH,
  runCalculator,
} from '@/features/calculator';
import type { ToolApprovalContext } from '@/features/tools/approval';

const CalculatorArgsSchema = z.object({
  expression: z
    .string()
    .max(CALCULATOR_MAX_INPUT_LENGTH)
    .refine(value => value.trim().length > 0, 'Expression must not be empty.')
    .describe('A numeric expression or help query, such as "(2 + 3) * 4", "mean(1, 2, 3)", "help", or "help log".'),
});

function throwIfAborted({ signal }: { signal: AbortSignal | undefined }): void {
  if (signal?.aborted !== true) return;
  const error = new Error('Generation aborted');
  error.name = 'AbortError';
  throw error;
}

export class CalculatorTool implements Tool {
  name = 'calculator';
  description = 'Evaluate deterministic numeric expressions without executing code. Use `help` for an overview or `help <topic>` for details.';
  parametersSchema = CalculatorArgsSchema;

  async execute({
    args,
    signal,
    onEvent: _onEvent,
    approvalContext: _approvalContext,
  }: {
    args: unknown,
    signal?: AbortSignal,
    onEvent?: ({ event }: { event: ToolExecutionEvent }) => void | Promise<void>,
    approvalContext?: ToolApprovalContext,
  }): Promise<
    | { status: 'success', content: string }
    | { status: 'error', code: ToolExecutionErrorCode, message: string }
  > {
    throwIfAborted({ signal });
    const validated = CalculatorArgsSchema.safeParse(args);
    if (!validated.success) {
      return {
        status: 'error',
        code: 'invalid_arguments',
        message: `Invalid arguments: ${validated.error.message}`,
      };
    }

    const result = runCalculator({ input: validated.data.expression });
    throwIfAborted({ signal });
    switch (result.status) {
    case 'success':
      return {
        status: 'success',
        content: result.output.text,
      };
    case 'error':
      return {
        status: 'error',
        code: 'execution_failed',
        message: result.text,
      };
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unhandled calculator result: ${String(_exhaustive)}`);
    }
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  CalculatorArgsSchema,
  throwIfAborted,
};
