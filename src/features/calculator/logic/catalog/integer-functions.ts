import { failCalculatorInput } from '@/features/calculator/logic/diagnostics';
import { CALCULATOR_LIMITS } from '@/features/calculator/logic/limits';
import { decimalDigitCount } from '@/features/calculator/logic/numeric/decimal';
import { NumericLimitError } from '@/features/calculator/logic/numeric/numeric-limit-error';
import { integerFromNumericValue, numericValueFromBigInt } from '@/features/calculator/logic/numeric/numeric-value';
import type { CalculatorFunctionDefinition } from './types';

function absoluteBigInt({ value }: { value: bigint }): bigint {
  return value < 0n ? -value : value;
}

function greatestCommonDivisor({ left, right, consumeOperation }: {
  left: bigint,
  right: bigint,
  consumeOperation: () => void,
}): bigint {
  let a = absoluteBigInt({ value: left });
  let b = absoluteBigInt({ value: right });
  while (b !== 0n) {
    consumeOperation();
    [a, b] = [b, a % b];
  }
  return a;
}

function ensureIntegerResultAllowed({ value }: { value: bigint }): void {
  if (decimalDigitCount({ value }) <= CALCULATOR_LIMITS.maximumCoefficientDigits) return;
  throw new NumericLimitError({
    reason: 'coefficient_digits',
    message: `Integer result exceeds ${CALCULATOR_LIMITS.maximumCoefficientDigits} digits.`,
  });
}

function requireNonNegative({ value, name, span }: {
  value: bigint,
  name: string,
  span: { readonly start: number, readonly end: number },
}): void {
  if (value >= 0n) return;
  failCalculatorInput({ code: 'invalid_argument', message: `${name} must be non-negative.`, span, hint: undefined });
}

function requireIterationLimit({ count, span }: {
  count: bigint,
  span: { readonly start: number, readonly end: number },
}): number {
  if (count > BigInt(CALCULATOR_LIMITS.maximumOperations)) {
    failCalculatorInput({
      code: 'limit_exceeded',
      message: `The integer operation requires more than ${CALCULATOR_LIMITS.maximumOperations} iterations.`,
      span,
      hint: 'Use smaller integer arguments.',
    });
  }
  return Number(count);
}

export const INTEGER_CALCULATOR_FUNCTIONS = [
  {
    name: 'gcd', category: 'integers',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: CALCULATOR_LIMITS.maximumFunctionArgumentCount },
    precision: 'exact', summary: 'Calculate the greatest common divisor of exact integers.', requirements: ['all values must be exact integers'],
    examples: [{ expression: 'gcd(48, 18)', result: '6', exactness: 'rational' }], related: ['lcm'],
    evaluate: ({ values, argumentSpans, callSpan, runtime }) => {
      let result = 0n;
      for (const [index, value] of values.entries()) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        result = greatestCommonDivisor({
          left: result,
          right: integerFromNumericValue({ value, name: 'gcd value', span: argumentSpans[index]! }),
          consumeOperation: () => runtime.consumeOperations({ count: 1, span: callSpan }),
        });
      }
      return numericValueFromBigInt({ value: result });
    },
  },
  {
    name: 'lcm', category: 'integers',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: CALCULATOR_LIMITS.maximumFunctionArgumentCount },
    precision: 'exact', summary: 'Calculate the least common multiple of exact integers.', requirements: ['all values must be exact integers'],
    examples: [{ expression: 'lcm(12, 18)', result: '36', exactness: 'rational' }], related: ['gcd'],
    evaluate: ({ values, argumentSpans, callSpan, runtime }) => {
      let result = 1n;
      for (const [index, value] of values.entries()) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        const integer = integerFromNumericValue({ value, name: 'lcm value', span: argumentSpans[index]! });
        if (result === 0n || integer === 0n) result = 0n;
        else {
          result = absoluteBigInt({
            value: result / greatestCommonDivisor({
              left: result,
              right: integer,
              consumeOperation: () => runtime.consumeOperations({ count: 1, span: callSpan }),
            }) * integer,
          });
          ensureIntegerResultAllowed({ value: result });
        }
      }
      return numericValueFromBigInt({ value: result });
    },
  },
  {
    name: 'factorial', category: 'integers', arguments: { type: 'exact', names: ['value'] }, precision: 'exact',
    summary: 'Calculate the factorial of a non-negative exact integer.', requirements: ['value must be a non-negative exact integer'],
    examples: [{ expression: 'factorial(10)', result: '3628800', exactness: 'rational' }], related: ['combinations', 'permutations'],
    evaluate: ({ values, argumentSpans, callSpan, runtime }) => {
      const value = integerFromNumericValue({ value: values[0]!, name: 'factorial value', span: argumentSpans[0]! });
      requireNonNegative({ value, name: 'factorial value', span: argumentSpans[0]! });
      const count = requireIterationLimit({ count: value, span: argumentSpans[0]! });
      let result = 1n;
      for (let current = 2; current <= count; current += 1) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        result *= BigInt(current);
        ensureIntegerResultAllowed({ value: result });
      }
      return numericValueFromBigInt({ value: result });
    },
  },
  {
    name: 'combinations', category: 'integers', arguments: { type: 'exact', names: ['n', 'r'] }, precision: 'exact',
    summary: 'Calculate the number of combinations n choose r.', requirements: ['n and r must be exact integers', '0 <= r <= n'],
    examples: [{ expression: 'combinations(10, 3)', result: '120', exactness: 'rational' }], related: ['permutations', 'factorial'],
    evaluate: ({ values, argumentSpans, callSpan, runtime }) => {
      const n = integerFromNumericValue({ value: values[0]!, name: 'n', span: argumentSpans[0]! });
      let r = integerFromNumericValue({ value: values[1]!, name: 'r', span: argumentSpans[1]! });
      requireNonNegative({ value: n, name: 'n', span: argumentSpans[0]! });
      requireNonNegative({ value: r, name: 'r', span: argumentSpans[1]! });
      if (r > n) {
        failCalculatorInput({ code: 'invalid_argument', message: 'combinations requires r <= n.', span: argumentSpans[1], hint: undefined });
      }
      if (r > n - r) r = n - r;
      const count = requireIterationLimit({ count: r, span: argumentSpans[1]! });
      let result = 1n;
      for (let index = 1; index <= count; index += 1) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        result = result * (n - r + BigInt(index)) / BigInt(index);
        ensureIntegerResultAllowed({ value: result });
      }
      return numericValueFromBigInt({ value: result });
    },
  },
  {
    name: 'permutations', category: 'integers', arguments: { type: 'exact', names: ['n', 'r'] }, precision: 'exact',
    summary: 'Calculate the number of ordered selections of r values from n.', requirements: ['n and r must be exact integers', '0 <= r <= n'],
    examples: [{ expression: 'permutations(10, 3)', result: '720', exactness: 'rational' }], related: ['combinations', 'factorial'],
    evaluate: ({ values, argumentSpans, callSpan, runtime }) => {
      const n = integerFromNumericValue({ value: values[0]!, name: 'n', span: argumentSpans[0]! });
      const r = integerFromNumericValue({ value: values[1]!, name: 'r', span: argumentSpans[1]! });
      requireNonNegative({ value: n, name: 'n', span: argumentSpans[0]! });
      requireNonNegative({ value: r, name: 'r', span: argumentSpans[1]! });
      if (r > n) {
        failCalculatorInput({ code: 'invalid_argument', message: 'permutations requires r <= n.', span: argumentSpans[1], hint: undefined });
      }
      const count = requireIterationLimit({ count: r, span: argumentSpans[1]! });
      let result = 1n;
      for (let index = 0; index < count; index += 1) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        result *= n - BigInt(index);
        ensureIntegerResultAllowed({ value: result });
      }
      return numericValueFromBigInt({ value: result });
    },
  },
] as const satisfies readonly CalculatorFunctionDefinition[];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = { greatestCommonDivisor, ensureIntegerResultAllowed };
