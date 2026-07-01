import type { CalculatorOperatorDefinition } from './types';

export const CALCULATOR_OPERATOR_DEFINITIONS = [
  { symbol: '+', summary: 'Add two values.', associativity: 'left' },
  { symbol: '-', summary: 'Subtract the right value from the left value.', associativity: 'left' },
  { symbol: '*', summary: 'Multiply two values.', associativity: 'left' },
  { symbol: '/', summary: 'Divide the left value by the right value.', associativity: 'left' },
  { symbol: '%', summary: 'Calculate Euclidean modulo with a positive divisor.', associativity: 'left' },
  { symbol: '^', summary: 'Raise the left value to the power of the right value.', associativity: 'right' },
] as const satisfies readonly CalculatorOperatorDefinition[];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
