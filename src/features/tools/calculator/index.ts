import { z } from 'zod';
import type { Tool, ToolExecutionErrorCode, ToolExecutionEvent } from '@/01-models/tool';
import {
  CALCULATOR_DEFAULT_RESULT_SIGNIFICANT_DIGITS,
  CALCULATOR_MAX_INPUT_LENGTH,
  CALCULATOR_MAX_RESULT_SIGNIFICANT_DIGITS,
  runCalculator,
} from '@/features/calculator';
import type { CalculatorOutputPolicy } from '@/features/calculator';
import type { ToolApprovalContext } from '@/features/tools/approval';

const CalculatorOutputSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('decimal'),
    significantDigits: z.number().int().min(1).max(CALCULATOR_MAX_RESULT_SIGNIFICANT_DIGITS).optional()
      .describe('Number of significant decimal digits. Defaults to 15.'),
  }).strict(),
  z.object({ format: z.literal('rational') }).strict(),
]);

const CalculatorArgsSchema = z.object({
  expression: z.string().max(CALCULATOR_MAX_INPUT_LENGTH)
    .refine(value => value.trim().length > 0, 'Expression must not be empty.')
    .describe('A numeric expression or help query, such as "1 / 3", "pi * 2", "mean(1, 2, 3)", "help", or "help precision".'),
  output: CalculatorOutputSchema.optional()
    .describe('Output configuration. Defaults to decimal with 15 significant digits. Rational output preserves exact fractions and rejects approximate results.'),
}).strict();

function resolveOutputPolicy({ output }: {
  output: z.infer<typeof CalculatorOutputSchema> | undefined,
}): CalculatorOutputPolicy {
  if (output === undefined) {
    return { format: 'decimal', significantDigits: CALCULATOR_DEFAULT_RESULT_SIGNIFICANT_DIGITS };
  }
  switch (output.format) {
  case 'decimal':
    return {
      format: 'decimal',
      significantDigits: output.significantDigits ?? CALCULATOR_DEFAULT_RESULT_SIGNIFICANT_DIGITS,
    };
  case 'rational':
    return { format: 'rational' };
  default: {
    const _exhaustive: never = output;
    throw new Error(`Unhandled calculator output configuration: ${String(_exhaustive)}`);
  }
  }
}

function throwIfAborted({ signal }: { signal: AbortSignal | undefined }): void {
  if (signal?.aborted !== true) return;
  const error = new Error('Generation aborted');
  error.name = 'AbortError';
  throw error;
}

export class CalculatorTool implements Tool {
  name = 'calculator';
  description = 'Evaluate deterministic numeric expressions without executing code. Decimal output defaults to 15 significant digits; rational output preserves exact fractions. Use `help` for an overview.';
  parametersSchema = CalculatorArgsSchema;

  async execute({ args, signal, onEvent: _onEvent, approvalContext: _approvalContext }: {
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
      return { status: 'error', code: 'invalid_arguments', message: `Invalid arguments: ${validated.error.message}` };
    }
    const result = runCalculator({
      input: validated.data.expression,
      output: resolveOutputPolicy({ output: validated.data.output }),
    });
    throwIfAborted({ signal });
    switch (result.status) {
    case 'success': return { status: 'success', content: result.output.text };
    case 'error': return { status: 'error', code: 'execution_failed', message: result.text };
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unhandled calculator result: ${String(_exhaustive)}`);
    }
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = { CalculatorArgsSchema, resolveOutputPolicy, throwIfAborted };
