import { z } from 'zod';
import { CALCULATOR_LIMITS } from '@/features/calculator/logic/limits';

export const CalculatorOutputSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('decimal'),
    significantDigits: z.number().int().min(1).max(CALCULATOR_LIMITS.maximumResultSignificantDigits).optional()
      .describe('Number of significant decimal digits. Defaults to 15.'),
  }).strict(),
  z.object({ format: z.literal('rational') }).strict(),
]);

export const CalculatorArgsSchema = z.object({
  expression: z.string().max(CALCULATOR_LIMITS.maximumInputLength)
    .refine(value => value.trim().length > 0, 'Expression must not be empty.')
    .describe('A numeric expression or help query, such as "1 / 3", "pi * 2", "mean(1, 2, 3)", "help", or "help precision".'),
  output: CalculatorOutputSchema.optional()
    .describe('Output configuration. Defaults to decimal with 15 significant digits. Rational output preserves exact fractions and rejects approximate results.'),
}).strict();

export const TEST_ONLY = {
};
