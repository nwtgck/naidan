import { z } from 'zod';
import { evaluate } from 'mathjs';
import type { Tool, ToolExecutionResult } from './types';

const CalculatorArgsSchema = z.object({
  expression: z.string().describe('The mathematical expression to evaluate (e.g., "2 + 3 * 4", "sqrt(16)", "cos(pi / 2)")'),
});

type CalculatorArgs = z.infer<typeof CalculatorArgsSchema>;

export class CalculatorTool implements Tool {
  name = 'calculator';
  description = 'Evaluate mathematical expressions using mathjs.';
  parametersSchema = CalculatorArgsSchema;

  async execute({ args }: { args: unknown }): Promise<ToolExecutionResult> {
    try {
      const validated = CalculatorArgsSchema.parse(args);
      const result = evaluate(validated.expression);
      return {
        status: 'success',
        content: String(result),
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          status: 'error',
          code: 'invalid_arguments',
          message: `Invalid arguments: ${error.message}`,
        };
      }
      // Calculation errors should be communicated to the LLM.
      return {
        status: 'error',
        code: 'execution_failed',
        message: `Error evaluating expression: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
