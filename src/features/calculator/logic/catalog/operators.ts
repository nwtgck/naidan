import type { CalculatorOperatorDefinition } from './types';

export const CALCULATOR_OPERATOR_DEFINITIONS = [
  { symbol: '+', summary: 'Add two numeric values.', associativity: 'left' },
  { symbol: '-', summary: 'Subtract the right value from the left value.', associativity: 'left' },
  { symbol: '*', summary: 'Multiply two numeric values.', associativity: 'left' },
  { symbol: '/', summary: 'Divide while preserving an exact rational result.', associativity: 'left' },
  { symbol: '%', summary: 'Calculate exact Euclidean modulo with a positive divisor.', associativity: 'left' },
  { symbol: '^', summary: 'Raise the left value to an exact integer power.', associativity: 'right' },
] as const satisfies readonly CalculatorOperatorDefinition[];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
