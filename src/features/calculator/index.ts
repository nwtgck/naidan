export {
  CALCULATOR_DEFAULT_RESULT_SIGNIFICANT_DIGITS,
  CALCULATOR_MAX_INPUT_LENGTH,
  CALCULATOR_MAX_RESULT_SIGNIFICANT_DIGITS,
  runCalculator,
} from './logic/run-calculator';
export type { CalculatorRunResult } from './logic/run-calculator';
export type { CalculatorOutputPolicy } from './logic/result-presentation';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
