import { failCalculatorInput } from '@/features/calculator/logic/diagnostics';
import type { CalculatorFunctionDefinition, CalculatorRuntime } from './types';

function requireSafeInteger({ value, span, name, minimum }: {
  value: number,
  span: { readonly start: number, readonly end: number },
  name: string,
  minimum: number | undefined,
}): void {
  if (!Number.isSafeInteger(value) || (minimum !== undefined && value < minimum)) {
    const minimumText = minimum === undefined ? '' : ` greater than or equal to ${minimum}`;
    failCalculatorInput({
      code: 'invalid_argument',
      message: `${name} must be a safe integer${minimumText}.`,
      span,
      hint: undefined,
    });
  }
}

function greatestCommonDivisor({ left, right, runtime, span }: {
  left: number,
  right: number,
  runtime: CalculatorRuntime,
  span: { readonly start: number, readonly end: number },
}): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    runtime.consumeOperations({ count: 1, span });
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export const INTEGER_CALCULATOR_FUNCTIONS = [
  {
    name: 'gcd',
    category: 'integers',
    arguments: { type: 'variadic', requiredNames: ['value', 'value'], maximumCount: 256 },
    summary: 'Calculate the greatest common divisor of safe integers.',
    requirements: ['at least two safe integers are required'],
    examples: [{ expression: 'gcd(48, 18)', result: '6' }],
    related: ['lcm'],
    evaluate: ({ values, argumentSpans, runtime, callSpan }) => {
      for (let index = 0; index < values.length; index += 1) {
        runtime.consumeOperations({ count: 1, span: argumentSpans[index] });
        requireSafeInteger({
          value: values[index]!,
          span: argumentSpans[index]!,
          name: 'gcd value',
          minimum: undefined,
        });
      }
      let result = 0;
      for (const value of values) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        result = greatestCommonDivisor({ left: result, right: value, runtime, span: callSpan });
      }
      return result;
    },
  },
  {
    name: 'lcm',
    category: 'integers',
    arguments: { type: 'variadic', requiredNames: ['value', 'value'], maximumCount: 256 },
    summary: 'Calculate the least common multiple of safe integers.',
    requirements: ['at least two safe integers are required', 'the result must remain a safe integer'],
    examples: [{ expression: 'lcm(12, 18)', result: '36' }],
    related: ['gcd'],
    evaluate: ({ values, argumentSpans, runtime, callSpan }) => {
      for (let index = 0; index < values.length; index += 1) {
        runtime.consumeOperations({ count: 1, span: argumentSpans[index] });
        requireSafeInteger({
          value: values[index]!,
          span: argumentSpans[index]!,
          name: 'lcm value',
          minimum: undefined,
        });
      }
      let result = 1;
      for (const value of values) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        if (result === 0 || value === 0) {
          result = 0;
          continue;
        }
        const divisor = greatestCommonDivisor({ left: result, right: value, runtime, span: callSpan });
        result = Math.abs((result / divisor) * value);
        if (!Number.isSafeInteger(result)) {
          failCalculatorInput({
            code: 'non_finite_result',
            message: 'lcm produced a value outside the safe integer range.',
            span: callSpan,
            hint: 'Use smaller integers.',
          });
        }
      }
      return result;
    },
  },
  {
    name: 'factorial',
    category: 'integers',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Calculate a non-negative integer factorial.',
    requirements: ['value must be an integer from 0 through 170'],
    examples: [{ expression: 'factorial(5)', result: '120' }],
    related: ['combinations', 'permutations'],
    evaluate: ({ values, argumentSpans, runtime, callSpan }) => {
      const value = values[0]!;
      requireSafeInteger({ value, span: argumentSpans[0]!, name: 'factorial value', minimum: 0 });
      if (value > 170) {
        failCalculatorInput({
          code: 'invalid_argument',
          message: 'factorial requires a value no greater than 170.',
          span: argumentSpans[0],
          hint: undefined,
        });
      }
      let result = 1;
      for (let factor = 2; factor <= value; factor += 1) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        result *= factor;
      }
      return result;
    },
  },
  {
    name: 'combinations',
    category: 'integers',
    arguments: { type: 'exact', names: ['n', 'r'] },
    summary: 'Calculate the number of unordered selections of r items from n items.',
    requirements: ['n and r must be non-negative safe integers', 'r must not exceed n'],
    examples: [{ expression: 'combinations(10, 3)', result: '120' }],
    related: ['permutations', 'factorial'],
    evaluate: ({ values, argumentSpans, runtime, callSpan }) => {
      const [n, originalR] = values as readonly [number, number];
      requireSafeInteger({ value: n, span: argumentSpans[0]!, name: 'n', minimum: 0 });
      requireSafeInteger({ value: originalR, span: argumentSpans[1]!, name: 'r', minimum: 0 });
      if (originalR > n) {
        failCalculatorInput({ code: 'invalid_argument', message: 'combinations requires r not to exceed n.', span: argumentSpans[1], hint: undefined });
      }
      const r = Math.min(originalR, n - originalR);
      let result = 1;
      for (let index = 1; index <= r; index += 1) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        result = result * (n - r + index) / index;
        if (!Number.isFinite(result)) break;
      }
      return result;
    },
  },
  {
    name: 'permutations',
    category: 'integers',
    arguments: { type: 'exact', names: ['n', 'r'] },
    summary: 'Calculate the number of ordered selections of r items from n items.',
    requirements: ['n and r must be non-negative safe integers', 'r must not exceed n'],
    examples: [{ expression: 'permutations(10, 3)', result: '720' }],
    related: ['combinations', 'factorial'],
    evaluate: ({ values, argumentSpans, runtime, callSpan }) => {
      const [n, r] = values as readonly [number, number];
      requireSafeInteger({ value: n, span: argumentSpans[0]!, name: 'n', minimum: 0 });
      requireSafeInteger({ value: r, span: argumentSpans[1]!, name: 'r', minimum: 0 });
      if (r > n) {
        failCalculatorInput({ code: 'invalid_argument', message: 'permutations requires r not to exceed n.', span: argumentSpans[1], hint: undefined });
      }
      let result = 1;
      for (let index = 0; index < r; index += 1) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        result *= n - index;
        if (!Number.isFinite(result)) break;
      }
      return result;
    },
  },
] as const satisfies readonly CalculatorFunctionDefinition[];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = { greatestCommonDivisor };
