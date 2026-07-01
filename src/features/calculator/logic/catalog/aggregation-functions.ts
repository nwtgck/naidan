import { CALCULATOR_LIMITS } from '@/features/calculator/logic/limits';
import {
  addNumericValues,
  compareNumericValues,
  divideNumericValues,
  multiplyNumericValues,
  numericValueFromBigInt,
  propagateApproximateInputs,
} from '@/features/calculator/logic/numeric/numeric-value';
import type { CalculatorFunctionDefinition } from './types';

const ZERO = numericValueFromBigInt({ value: 0n });
const ONE = numericValueFromBigInt({ value: 1n });

export const AGGREGATION_CALCULATOR_FUNCTIONS = [
  {
    name: 'min', category: 'aggregation',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: CALCULATOR_LIMITS.maximumFunctionArgumentCount },
    precision: 'conditional', summary: 'Return the smallest value.', requirements: [],
    examples: [{ expression: 'min(8, -2, 5)', result: '-2', exactness: 'rational' }], related: ['max', 'clamp'],
    evaluate: ({ values, runtime, callSpan }) => {
      let result = values[0]!;
      for (const value of values.slice(1)) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        if (compareNumericValues({ left: value, right: result }) < 0) result = value;
      }
      return propagateApproximateInputs({ value: result, inputs: values });
    },
  },
  {
    name: 'max', category: 'aggregation',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: CALCULATOR_LIMITS.maximumFunctionArgumentCount },
    precision: 'conditional', summary: 'Return the largest value.', requirements: [],
    examples: [{ expression: 'max(8, -2, 5)', result: '8', exactness: 'rational' }], related: ['min', 'clamp'],
    evaluate: ({ values, runtime, callSpan }) => {
      let result = values[0]!;
      for (const value of values.slice(1)) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        if (compareNumericValues({ left: value, right: result }) > 0) result = value;
      }
      return propagateApproximateInputs({ value: result, inputs: values });
    },
  },
  {
    name: 'sum', category: 'aggregation',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: CALCULATOR_LIMITS.maximumFunctionArgumentCount },
    precision: 'conditional', summary: 'Add all values while retaining exact rational arithmetic.', requirements: [],
    examples: [{ expression: 'sum(1, 2, 3, 4)', result: '10', exactness: 'rational' }], related: ['product', 'mean'],
    evaluate: ({ values, runtime, callSpan }) => {
      let result = ZERO;
      for (const value of values) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        result = addNumericValues({ left: result, right: value });
      }
      return result;
    },
  },
  {
    name: 'product', category: 'aggregation',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: CALCULATOR_LIMITS.maximumFunctionArgumentCount },
    precision: 'conditional', summary: 'Multiply all values.', requirements: [],
    examples: [{ expression: 'product(2, 3, 4)', result: '24', exactness: 'rational' }], related: ['sum'],
    evaluate: ({ values, runtime, callSpan }) => {
      let result = ONE;
      for (const value of values) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        result = multiplyNumericValues({ left: result, right: value });
      }
      return result;
    },
  },
  {
    name: 'mean', category: 'aggregation',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: CALCULATOR_LIMITS.maximumFunctionArgumentCount },
    precision: 'conditional', summary: 'Calculate the arithmetic mean while preserving a rational result.', requirements: [],
    examples: [{ expression: 'mean(10, 20, 30)', result: '20', exactness: 'rational' }], related: ['sum', 'median'],
    evaluate: ({ values, runtime, callSpan }) => {
      let sum = ZERO;
      for (const value of values) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        sum = addNumericValues({ left: sum, right: value });
      }
      return divideNumericValues({
        numerator: sum,
        denominator: numericValueFromBigInt({ value: BigInt(values.length) }),
        span: callSpan,
      });
    },
  },
  {
    name: 'median', category: 'aggregation',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: CALCULATOR_LIMITS.maximumFunctionArgumentCount },
    precision: 'conditional', summary: 'Calculate the median.', requirements: [],
    examples: [{ expression: 'median(1, 9, 3, 5)', result: '4', exactness: 'rational' }], related: ['mean'],
    evaluate: ({ values, runtime, callSpan }) => {
      runtime.consumeOperations({ count: values.length * Math.ceil(Math.log2(values.length + 1)), span: callSpan });
      const sorted = [...values].sort((left, right) => compareNumericValues({ left, right }));
      const middle = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) {
        return propagateApproximateInputs({ value: sorted[middle]!, inputs: values });
      }
      return divideNumericValues({
        numerator: addNumericValues({ left: sorted[middle - 1]!, right: sorted[middle]! }),
        denominator: numericValueFromBigInt({ value: 2n }),
        span: callSpan,
      });
    },
  },
] as const satisfies readonly CalculatorFunctionDefinition[];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
