import { describe, expect, it } from 'vitest';
import {
  listCalculatorConstants,
  listCalculatorFunctions,
  listCalculatorOperators,
} from './catalog';
import type { CalculatorOutputPolicy } from './result-presentation';
import { runCalculator } from './run-calculator';

const DECIMAL_15: CalculatorOutputPolicy = {
  format: 'decimal',
  significantDigits: 15,
};
const RATIONAL: CalculatorOutputPolicy = { format: 'rational' };

type SuccessCase = {
  readonly operation: string,
  readonly input: string,
  readonly text: string,
  readonly exactness: 'rational' | 'approximate',
  readonly output?: CalculatorOutputPolicy,
};

type ErrorCase = {
  readonly operation: string,
  readonly input: string,
  readonly code:
    | 'division_by_zero'
    | 'domain_error'
    | 'invalid_argument'
    | 'invalid_argument_count'
    | 'limit_exceeded'
    | 'result_not_rational',
  readonly output?: CalculatorOutputPolicy,
};

const OPERATOR_CASES = [
  { operation: '+', input: '0.1 + 0.2', text: '0.3', exactness: 'rational' },
  { operation: '+', input: 'pi + 1', text: '4.14159265358979', exactness: 'approximate' },
  { operation: '-', input: '5 - 8', text: '-3', exactness: 'rational' },
  { operation: '-', input: 'pi - 3', text: '0.141592653589793', exactness: 'approximate' },
  { operation: '*', input: '-2 * 3.5', text: '-7', exactness: 'rational' },
  { operation: '*', input: 'pi * 2', text: '6.28318530717959', exactness: 'approximate' },
  { operation: '/', input: '1 / 8', text: '0.125', exactness: 'rational' },
  { operation: '/', input: '1 / 3', text: '1/3', exactness: 'rational', output: RATIONAL },
  { operation: '/', input: 'pi / 2', text: '1.5707963267949', exactness: 'approximate' },
  { operation: '%', input: '5.5 % 2', text: '1.5', exactness: 'rational' },
  { operation: '%', input: '-5.5 % 2', text: '0.5', exactness: 'rational' },
  { operation: '%', input: '-17 % 5', text: '3', exactness: 'rational' },
  { operation: '^', input: '2 ^ 10', text: '1024', exactness: 'rational' },
  { operation: '^', input: '2 ^ -3', text: '0.125', exactness: 'rational' },
  { operation: '^', input: 'pi ^ 2', text: '9.86960440108936', exactness: 'approximate' },
] as const satisfies readonly SuccessCase[];

const FUNCTION_CASES = [
  { operation: 'abs', input: 'abs(-12.5)', text: '12.5', exactness: 'rational' },
  { operation: 'abs', input: 'abs(-pi)', text: '3.14159265358979', exactness: 'approximate' },
  { operation: 'sign', input: 'sign(-8)', text: '-1', exactness: 'rational' },
  { operation: 'sign', input: 'sign(0)', text: '0', exactness: 'rational' },
  { operation: 'sign', input: 'sign(pi)', text: '1', exactness: 'approximate' },
  { operation: 'clamp', input: 'clamp(-1, 0, 10)', text: '0', exactness: 'rational' },
  { operation: 'clamp', input: 'clamp(5, 0, 10)', text: '5', exactness: 'rational' },
  { operation: 'clamp', input: 'clamp(11, 0, 10)', text: '10', exactness: 'rational' },
  { operation: 'clamp', input: 'clamp(pi, 3, 4)', text: '3.14159265358979', exactness: 'approximate' },
  { operation: 'clamp', input: 'clamp(pi, 4, 5)', text: '4', exactness: 'approximate' },
  { operation: 'sqrt', input: 'sqrt(0)', text: '0', exactness: 'rational' },
  { operation: 'sqrt', input: 'sqrt(0.25)', text: '0.5', exactness: 'rational' },
  { operation: 'sqrt', input: 'sqrt(4 / 9)', text: '2/3', exactness: 'rational', output: RATIONAL },
  { operation: 'sqrt', input: 'sqrt(2)', text: '1.4142135623731', exactness: 'approximate' },
  { operation: 'cbrt', input: 'cbrt(-0.008)', text: '-0.2', exactness: 'rational' },
  { operation: 'cbrt', input: 'cbrt(1 / 8)', text: '0.5', exactness: 'rational' },
  { operation: 'cbrt', input: 'cbrt(2)', text: '1.25992104989487', exactness: 'approximate' },
  { operation: 'pow', input: 'pow(-2, 3)', text: '-8', exactness: 'rational' },
  { operation: 'pow', input: 'pow(-2, -3)', text: '-0.125', exactness: 'rational' },
  { operation: 'pow', input: 'pow(pi, 2)', text: '9.86960440108936', exactness: 'approximate' },
  { operation: 'hypot', input: 'hypot(3, 4)', text: '5', exactness: 'rational' },
  { operation: 'hypot', input: 'hypot(1, 2, 2)', text: '3', exactness: 'rational' },
  { operation: 'hypot', input: 'hypot(pi, 0)', text: '3.14159265358979', exactness: 'approximate' },
  { operation: 'floor', input: 'floor(-1.2)', text: '-2', exactness: 'rational' },
  { operation: 'floor', input: 'floor(pi)', text: '3', exactness: 'approximate' },
  { operation: 'floor', input: 'floor(1 / (2 ^ 3400))', text: '0', exactness: 'rational' },
  { operation: 'ceil', input: 'ceil(-1.2)', text: '-1', exactness: 'rational' },
  { operation: 'ceil', input: 'ceil(pi)', text: '4', exactness: 'approximate' },
  { operation: 'trunc', input: 'trunc(-1.8)', text: '-1', exactness: 'rational' },
  { operation: 'trunc', input: 'trunc(pi)', text: '3', exactness: 'approximate' },
  { operation: 'round', input: 'round(1.5)', text: '2', exactness: 'rational' },
  { operation: 'round', input: 'round(-1.5)', text: '-2', exactness: 'rational' },
  { operation: 'round', input: 'round(pi)', text: '3', exactness: 'approximate' },
  { operation: 'round_to', input: 'round_to(1.005, 2)', text: '1.01', exactness: 'rational' },
  { operation: 'round_to', input: 'round_to(-1.005, 2)', text: '-1.01', exactness: 'rational' },
  { operation: 'round_to', input: 'round_to(149, -2)', text: '100', exactness: 'rational' },
  { operation: 'round_to', input: 'round_to(pi, 2)', text: '3.14', exactness: 'approximate' },
  { operation: 'round_to', input: 'round_to(2819200000000 / 115443, 0)', text: '24420710', exactness: 'rational' },
  { operation: 'round_to', input: 'round_to(1 / (2 ^ 3400), 0)', text: '0', exactness: 'rational' },
  { operation: 'percent_of', input: 'percent_of(15, 240)', text: '36', exactness: 'rational' },
  { operation: 'percent_of', input: 'percent_of(50, pi)', text: '1.5707963267949', exactness: 'approximate' },
  { operation: 'increase_by_percent', input: 'increase_by_percent(100, -10)', text: '90', exactness: 'rational' },
  { operation: 'increase_by_percent', input: 'increase_by_percent(pi, 10)', text: '3.45575191894877', exactness: 'approximate' },
  { operation: 'decrease_by_percent', input: 'decrease_by_percent(100, -10)', text: '110', exactness: 'rational' },
  { operation: 'decrease_by_percent', input: 'decrease_by_percent(pi, 10)', text: '2.82743338823081', exactness: 'approximate' },
  { operation: 'percent_change', input: 'percent_change(200, 250)', text: '25', exactness: 'rational' },
  { operation: 'percent_change', input: 'percent_change(-200, -250)', text: '-25', exactness: 'rational' },
  { operation: 'percent_change', input: 'percent_change(pi, tau)', text: '100', exactness: 'approximate' },
  { operation: 'deg_to_rad', input: 'deg_to_rad(90)', text: '1.5707963267949', exactness: 'approximate' },
  { operation: 'rad_to_deg', input: 'rad_to_deg(pi / 2)', text: '90', exactness: 'approximate' },
  { operation: 'min', input: 'min(0.25, 0.5)', text: '0.25', exactness: 'rational' },
  { operation: 'min', input: 'min(pi, 4)', text: '3.14159265358979', exactness: 'approximate' },
  { operation: 'max', input: 'max(-0.25, 0)', text: '0', exactness: 'rational' },
  { operation: 'max', input: 'max(pi, 3)', text: '3.14159265358979', exactness: 'approximate' },
  { operation: 'max', input: 'max(pi, 4)', text: '4', exactness: 'approximate' },
  { operation: 'sum', input: 'sum(1 / 3, 1 / 6)', text: '0.5', exactness: 'rational' },
  { operation: 'sum', input: 'sum(pi, 1)', text: '4.14159265358979', exactness: 'approximate' },
  { operation: 'product', input: 'product(1 / 3, 6)', text: '2', exactness: 'rational' },
  { operation: 'product', input: 'product(pi, 2)', text: '6.28318530717959', exactness: 'approximate' },
  { operation: 'mean', input: 'mean(1, 2, 2)', text: '5/3', exactness: 'rational', output: RATIONAL },
  { operation: 'mean', input: 'mean(pi, pi)', text: '3.14159265358979', exactness: 'approximate' },
  { operation: 'median', input: 'median(9, 1, 5)', text: '5', exactness: 'rational' },
  { operation: 'median', input: 'median(1, 2)', text: '1.5', exactness: 'rational' },
  { operation: 'median', input: 'median(pi, 3, 4)', text: '3.14159265358979', exactness: 'approximate' },
  { operation: 'median', input: 'median(pi, 4, 5)', text: '4', exactness: 'approximate' },
  { operation: 'gcd', input: 'gcd(0, 0)', text: '0', exactness: 'rational' },
  { operation: 'gcd', input: 'gcd(-48, 18, 30)', text: '6', exactness: 'rational' },
  { operation: 'lcm', input: 'lcm(0, 18)', text: '0', exactness: 'rational' },
  { operation: 'lcm', input: 'lcm(-12, 18)', text: '36', exactness: 'rational' },
  { operation: 'factorial', input: 'factorial(0)', text: '1', exactness: 'rational' },
  { operation: 'factorial', input: 'factorial(10)', text: '3628800', exactness: 'rational' },
  { operation: 'combinations', input: 'combinations(10, 0)', text: '1', exactness: 'rational' },
  { operation: 'combinations', input: 'combinations(10, 7)', text: '120', exactness: 'rational' },
  { operation: 'permutations', input: 'permutations(10, 0)', text: '1', exactness: 'rational' },
  { operation: 'permutations', input: 'permutations(10, 10)', text: '3628800', exactness: 'rational' },
] as const satisfies readonly SuccessCase[];

const CONSTANT_CASES = [
  { operation: 'pi', input: 'pi', text: '3.14159265358979', exactness: 'approximate' },
  { operation: 'e', input: 'e', text: '2.71828182845905', exactness: 'approximate' },
  { operation: 'tau', input: 'tau', text: '6.28318530717959', exactness: 'approximate' },
] as const satisfies readonly SuccessCase[];

const ERROR_CASES: readonly ErrorCase[] = [
  { operation: '/', input: '1 / 0', code: 'division_by_zero' },
  { operation: '%', input: '5 % 0', code: 'invalid_argument' },
  { operation: '%', input: '5 % -2', code: 'invalid_argument' },
  { operation: '%', input: 'pi % 2', code: 'invalid_argument' },
  { operation: '^', input: '0 ^ -1', code: 'division_by_zero' },
  { operation: '^', input: '2 ^ 0.5', code: 'invalid_argument' },
  { operation: 'clamp', input: 'clamp(1, 2, 0)', code: 'invalid_argument' },
  { operation: 'sqrt', input: 'sqrt(-0.25)', code: 'domain_error' },
  { operation: 'pow', input: 'pow(2, 0.5)', code: 'invalid_argument' },
  { operation: 'round_to', input: 'round_to(1.23, 0.5)', code: 'invalid_argument' },
  { operation: 'round_to', input: 'round_to(1.23, 1025)', code: 'limit_exceeded' },
  { operation: 'percent_change', input: 'percent_change(0, 1)', code: 'division_by_zero' },
  { operation: 'gcd', input: 'gcd(1.5, 2)', code: 'invalid_argument' },
  { operation: 'lcm', input: 'lcm(pi, 2)', code: 'invalid_argument' },
  { operation: 'factorial', input: 'factorial(-1)', code: 'invalid_argument' },
  { operation: 'factorial', input: 'factorial(1.5)', code: 'invalid_argument' },
  { operation: 'combinations', input: 'combinations(5, -1)', code: 'invalid_argument' },
  { operation: 'combinations', input: 'combinations(5, 6)', code: 'invalid_argument' },
  { operation: 'permutations', input: 'permutations(5, -1)', code: 'invalid_argument' },
  { operation: 'permutations', input: 'permutations(5, 6)', code: 'invalid_argument' },
  { operation: 'min', input: 'min()', code: 'invalid_argument_count' },
  { operation: 'hypot', input: 'hypot()', code: 'invalid_argument_count' },
  { operation: 'pi', input: 'pi', code: 'result_not_rational', output: RATIONAL },
  { operation: 'max', input: 'max(pi, 4)', code: 'result_not_rational', output: RATIONAL },
  { operation: 'clamp', input: 'clamp(pi, 4, 5)', code: 'result_not_rational', output: RATIONAL },
  { operation: 'median', input: 'median(pi, 4, 5)', code: 'result_not_rational', output: RATIONAL },
];

function expectSuccess({ input, text, exactness, output = DECIMAL_15 }: SuccessCase): void {
  expect(runCalculator({ input, output }), input).toEqual({
    status: 'success',
    output: { kind: 'value', text, exactness },
  });
}

describe('calculator operators', () => {
  it('has at least one successful case for every registered operator', () => {
    expect(new Set(OPERATOR_CASES.map(testCase => testCase.operation))).toEqual(
      new Set(listCalculatorOperators().map(definition => definition.symbol)),
    );
  });

  for (const testCase of OPERATOR_CASES) {
    it(`${testCase.operation}: ${testCase.input}`, () => {
      expectSuccess(testCase);
    });
  }
});

describe('calculator functions', () => {
  it('has at least one successful case for every registered function', () => {
    expect(new Set(FUNCTION_CASES.map(testCase => testCase.operation))).toEqual(
      new Set(listCalculatorFunctions().map(definition => definition.name)),
    );
  });

  for (const testCase of FUNCTION_CASES) {
    it(`${testCase.operation}: ${testCase.input}`, () => {
      expectSuccess(testCase);
    });
  }
});

describe('calculator constants', () => {
  it('has a case for every registered constant', () => {
    expect(new Set(CONSTANT_CASES.map(testCase => testCase.operation))).toEqual(
      new Set(listCalculatorConstants().map(definition => definition.name)),
    );
  });

  for (const testCase of CONSTANT_CASES) {
    it(`${testCase.operation}: ${testCase.input}`, () => {
      expectSuccess(testCase);
    });
  }
});

describe('calculator operation errors', () => {
  for (const testCase of ERROR_CASES) {
    it(`${testCase.operation}: ${testCase.input} -> ${testCase.code}`, () => {
      const result = runCalculator({ input: testCase.input, output: testCase.output ?? DECIMAL_15 });
      expect(result.status, testCase.input).toBe('error');
      if (result.status === 'error') expect(result.diagnostic.code).toBe(testCase.code);
    });
  }
});

describe('calculator cross-operation invariants', () => {
  for (const numerator of [-7, -1, 0, 1, 7]) {
    for (const denominator of [1, 2, 5]) {
      it(`preserves (${numerator} / ${denominator}) * ${denominator}`, () => {
        expectSuccess({
          operation: 'rational inverse',
          input: `(${numerator} / ${denominator}) * ${denominator}`,
          output: RATIONAL,
          text: String(numerator),
          exactness: 'rational',
        });
      });
    }
  }

  it('keeps Euclidean modulo within the positive divisor range and reconstructs the dividend', () => {
    for (const dividend of [-17, -6, -1, 0, 1, 6, 17]) {
      for (const divisor of [2, 5]) {
        const remainder = runCalculator({
          input: `${dividend} % ${divisor}`,
          output: RATIONAL,
        });
        expect(remainder.status).toBe('success');
        if (remainder.status !== 'success' || remainder.output.kind !== 'value') continue;
        const numericRemainder = Number(remainder.output.text);
        expect(numericRemainder >= 0).toBe(true);
        expect(numericRemainder < divisor).toBe(true);
        expectSuccess({
          operation: 'Euclidean reconstruction',
          input: `floor(${dividend} / ${divisor}) * ${divisor} + (${dividend} % ${divisor})`,
          output: RATIONAL,
          text: String(dividend),
          exactness: 'rational',
        });
      }
    }
  });

  it('keeps combinatorial identities exact', () => {
    expectSuccess({
      operation: 'combination symmetry',
      input: 'combinations(20, 3) - combinations(20, 17)',
      output: RATIONAL,
      text: '0',
      exactness: 'rational',
    });
    expectSuccess({
      operation: 'permutation identity',
      input: 'permutations(10, 3) - combinations(10, 3) * factorial(3)',
      output: RATIONAL,
      text: '0',
      exactness: 'rational',
    });
  });

  it('keeps constants and angle conversions internally consistent at decimal precision', () => {
    const decimal50: CalculatorOutputPolicy = { format: 'decimal', significantDigits: 50 };
    const pi = runCalculator({ input: 'pi', output: decimal50 });
    const halfTau = runCalculator({ input: 'tau / 2', output: decimal50 });
    expect(halfTau).toEqual(pi);
    expectSuccess({
      operation: 'angle round trip',
      input: 'rad_to_deg(deg_to_rad(45))',
      text: '45',
      exactness: 'approximate',
    });
  });
});
