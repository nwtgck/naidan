import type { CalculatorConstantDefinition } from './types';

export const CALCULATOR_CONSTANT_DEFINITIONS = [
  { name: 'pi', value: Math.PI, summary: 'The circle constant π.' },
  { name: 'e', value: Math.E, summary: 'Euler\'s number.' },
  { name: 'tau', value: Math.PI * 2, summary: 'The circle constant τ, equal to 2 * pi.' },
] as const satisfies readonly CalculatorConstantDefinition[];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
