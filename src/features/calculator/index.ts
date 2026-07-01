export {
  CALCULATOR_MAX_INPUT_LENGTH,
  runCalculator,
} from './logic/run-calculator';

export type {
  CalculatorRunResult,
} from './logic/run-calculator';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
