import type {
  CalculatorFunctionDefinition,
  CalculatorRuntime,
} from './types';
import type { SourceSpan } from '@/features/calculator/logic/syntax';

function getMaximumMagnitude({
  values,
  runtime,
  span,
}: {
  values: readonly number[],
  runtime: CalculatorRuntime,
  span: SourceSpan,
}): number {
  let maximum = 0;
  for (const value of values) {
    runtime.consumeOperations({ count: 1, span });
    maximum = Math.max(maximum, Math.abs(value));
  }
  return maximum;
}

function compensatedScaledSum({
  values,
  scale,
  runtime,
  span,
}: {
  values: readonly number[],
  scale: number,
  runtime: CalculatorRuntime,
  span: SourceSpan,
}): number {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    runtime.consumeOperations({ count: 1, span });
    const adjusted = value / scale - correction;
    const next = sum + adjusted;
    correction = (next - sum) - adjusted;
    sum = next;
  }
  return sum;
}

function calculateStableSum({
  values,
  runtime,
  span,
}: {
  values: readonly number[],
  runtime: CalculatorRuntime,
  span: SourceSpan,
}): number {
  const scale = getMaximumMagnitude({ values, runtime, span });
  if (scale === 0) return 0;
  return compensatedScaledSum({ values, scale, runtime, span }) * scale;
}

function calculateStableMean({
  values,
  runtime,
  span,
}: {
  values: readonly number[],
  runtime: CalculatorRuntime,
  span: SourceSpan,
}): number {
  const scale = getMaximumMagnitude({ values, runtime, span });
  if (scale === 0) return 0;
  return compensatedScaledSum({ values, scale, runtime, span })
    / values.length
    * scale;
}

function calculateMidpoint({ left, right }: { left: number, right: number }): number {
  if (Math.sign(left) === Math.sign(right)) {
    return left + (right - left) / 2;
  }
  return left / 2 + right / 2;
}

export const AGGREGATION_CALCULATOR_FUNCTIONS = [
  {
    name: 'min',
    category: 'aggregation',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: 256 },
    summary: 'Return the smallest value.',
    requirements: ['at least one value is required'],
    examples: [{ expression: 'min(8, -2, 5)', result: '-2' }],
    related: ['max', 'clamp'],
    evaluate: ({ values, runtime, callSpan }) => {
      runtime.consumeOperations({ count: values.length, span: callSpan });
      return Math.min(...values);
    },
  },
  {
    name: 'max',
    category: 'aggregation',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: 256 },
    summary: 'Return the largest value.',
    requirements: ['at least one value is required'],
    examples: [{ expression: 'max(8, -2, 5)', result: '8' }],
    related: ['min', 'clamp'],
    evaluate: ({ values, runtime, callSpan }) => {
      runtime.consumeOperations({ count: values.length, span: callSpan });
      return Math.max(...values);
    },
  },
  {
    name: 'sum',
    category: 'aggregation',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: 256 },
    summary: 'Add all values using scaled compensated summation.',
    requirements: ['at least one value is required'],
    examples: [{ expression: 'sum(1, 2, 3, 4)', result: '10' }],
    related: ['product', 'mean'],
    evaluate: ({ values, runtime, callSpan }) => calculateStableSum({
      values,
      runtime,
      span: callSpan,
    }),
  },
  {
    name: 'product',
    category: 'aggregation',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: 256 },
    summary: 'Multiply all values.',
    requirements: ['at least one value is required', 'the result must be finite'],
    examples: [{ expression: 'product(2, 3, 4)', result: '24' }],
    related: ['sum'],
    evaluate: ({ values, runtime, callSpan }) => {
      let result = 1;
      for (const value of values) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        result *= value;
      }
      return result;
    },
  },
  {
    name: 'mean',
    category: 'aggregation',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: 256 },
    summary: 'Calculate the arithmetic mean without avoidable intermediate overflow.',
    requirements: ['at least one value is required'],
    examples: [{ expression: 'mean(10, 20, 30)', result: '20' }],
    related: ['sum', 'median'],
    evaluate: ({ values, runtime, callSpan }) => calculateStableMean({
      values,
      runtime,
      span: callSpan,
    }),
  },
  {
    name: 'median',
    category: 'aggregation',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: 256 },
    summary: 'Calculate the median.',
    requirements: ['at least one value is required'],
    examples: [{ expression: 'median(1, 9, 3, 5)', result: '4' }],
    related: ['mean'],
    evaluate: ({ values, runtime, callSpan }) => {
      const estimatedSortCost = values.length * Math.ceil(Math.log2(values.length + 1));
      runtime.consumeOperations({ count: estimatedSortCost, span: callSpan });
      const sorted = [...values].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) return sorted[middle]!;
      return calculateMidpoint({
        left: sorted[middle - 1]!,
        right: sorted[middle]!,
      });
    },
  },
] as const satisfies readonly CalculatorFunctionDefinition[];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  calculateMidpoint,
  calculateStableMean,
  calculateStableSum,
  compensatedScaledSum,
  getMaximumMagnitude,
};
