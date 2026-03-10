import { z } from 'zod';
import { evaluate } from 'mathjs';
import type { Tool } from './types';

const CalculatorArgsSchema = z.object({
  expression: z.string().describe('The mathematical expression to evaluate (e.g., "2 + 3 * 4", "sqrt(16)", "cos(pi / 2)")'),
});

export class CalculatorTool implements Tool {
  name = 'calculator';
  description = 'Evaluate mathematical expressions using mathjs.';
  parametersSchema = CalculatorArgsSchema;

  async execute({ args, signal }: { args: unknown; signal?: AbortSignal }): Promise<
    | { status: 'success'; content: string }
    | { status: 'error'; code: import('./types').ToolExecutionErrorCode; message: string }
  > {
    try {
      if (signal?.aborted) throw new Error('Generation aborted');
      const validated = CalculatorArgsSchema.parse(args);
      const result = evaluate(validated.expression);
      return {
        status: 'success',
        content: String(result),
      };
    } catch (error) {
      // Calculation errors should be communicated to the LLM.
      return {
        status: 'error',
        code: 'execution_failed',
        message: `Error evaluating expression: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
