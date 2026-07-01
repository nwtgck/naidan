import { parseApproximateConstant } from '@/features/calculator/logic/numeric/numeric-value';
import type { CalculatorConstantDefinition } from './types';

export const CALCULATOR_PI_VALUE = parseApproximateConstant({
  literal: '3.141592653589793238462643383279502884197169399375105820974944592307816406286',
});

export const CALCULATOR_CONSTANT_DEFINITIONS = [
  {
    name: 'pi',
    value: CALCULATOR_PI_VALUE,
    precision: 'approximate',
    summary: 'The bounded decimal approximation of the circle constant π.',
  },
  {
    name: 'e',
    value: parseApproximateConstant({
      literal: '2.718281828459045235360287471352662497757247093699959574966967627724076630354',
    }),
    precision: 'approximate',
    summary: 'The bounded decimal approximation of Euler\'s number.',
  },
  {
    name: 'tau',
    value: parseApproximateConstant({
      literal: '6.283185307179586476925286766559005768394338798750211641949889184615632812572',
    }),
    precision: 'approximate',
    summary: 'The bounded decimal approximation of τ, equal to 2 * pi.',
  },
] as const satisfies readonly CalculatorConstantDefinition[];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
