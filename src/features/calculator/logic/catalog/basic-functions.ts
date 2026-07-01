import { failCalculatorInput } from '@/features/calculator/logic/diagnostics';
import type { CalculatorFunctionDefinition } from './types';

function requireFiniteArgument({ value, span, name }: {
  value: number,
  span: { readonly start: number, readonly end: number },
  name: string,
}): void {
  if (!Number.isFinite(value)) {
    failCalculatorInput({
      code: 'invalid_argument',
      message: `${name} must be finite.`,
      span,
      hint: undefined,
    });
  }
}

function roundHalfAwayFromZero({ value }: { value: number }): number {
  return value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
}

function shiftDecimalExponent({ value, amount }: { value: number, amount: number }): number {
  const [coefficient, exponentText] = String(value).toLowerCase().split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Number(`${coefficient}e${exponent + amount}`);
}

function calculatePercentageOf({ percent, value }: {
  percent: number,
  value: number,
}): number {
  if (Math.abs(percent) >= 100) {
    return percent / 100 * value;
  }
  return percent * (value / 100);
}

export const BASIC_CALCULATOR_FUNCTIONS = [
  {
    name: 'abs',
    category: 'arithmetic',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Return the absolute value.',
    requirements: [],
    examples: [{ expression: 'abs(-12.5)', result: '12.5' }],
    related: ['sign'],
    evaluate: ({ values }) => Math.abs(values[0]!),
  },
  {
    name: 'sign',
    category: 'arithmetic',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Return -1, 0, or 1 according to the sign of a value.',
    requirements: [],
    examples: [{ expression: 'sign(-8)', result: '-1' }],
    related: ['abs'],
    evaluate: ({ values }) => Math.sign(values[0]!),
  },
  {
    name: 'clamp',
    category: 'arithmetic',
    arguments: { type: 'exact', names: ['value', 'minimum', 'maximum'] },
    summary: 'Restrict a value to an inclusive range.',
    requirements: ['minimum must not be greater than maximum'],
    examples: [{ expression: 'clamp(120, 0, 100)', result: '100' }],
    related: ['min', 'max'],
    evaluate: ({ values, argumentSpans }) => {
      const [value, minimum, maximum] = values as readonly [number, number, number];
      if (minimum > maximum) {
        failCalculatorInput({
          code: 'invalid_argument',
          message: 'clamp requires minimum to be less than or equal to maximum.',
          span: argumentSpans[1],
          hint: undefined,
        });
      }
      return Math.min(Math.max(value, minimum), maximum);
    },
  },
  {
    name: 'sqrt',
    category: 'powers',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Calculate the principal square root.',
    requirements: ['value must be non-negative'],
    examples: [{ expression: 'sqrt(81)', result: '9' }],
    related: ['cbrt', 'pow'],
    evaluate: ({ values, argumentSpans }) => {
      const value = values[0]!;
      if (value < 0) {
        failCalculatorInput({
          code: 'domain_error',
          message: 'sqrt requires a non-negative value.',
          span: argumentSpans[0],
          hint: 'Complex numbers are not supported.',
        });
      }
      return Math.sqrt(value);
    },
  },
  {
    name: 'cbrt',
    category: 'powers',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Calculate the real cube root.',
    requirements: [],
    examples: [{ expression: 'cbrt(-27)', result: '-3' }],
    related: ['sqrt', 'pow'],
    evaluate: ({ values }) => Math.cbrt(values[0]!),
  },
  {
    name: 'pow',
    category: 'powers',
    arguments: { type: 'exact', names: ['value', 'exponent'] },
    summary: 'Raise a value to a power.',
    requirements: ['the result must be a finite real number'],
    examples: [{ expression: 'pow(2, 10)', result: '1024' }],
    related: ['sqrt', 'cbrt'],
    evaluate: ({ values }) => Math.pow(values[0]!, values[1]!),
  },
  {
    name: 'hypot',
    category: 'powers',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: 256 },
    summary: 'Calculate the square root of the sum of squared values.',
    requirements: ['at least one value is required'],
    examples: [{ expression: 'hypot(3, 4)', result: '5' }],
    related: ['sqrt'],
    evaluate: ({ values, runtime, callSpan }) => {
      runtime.consumeOperations({ count: values.length, span: callSpan });
      return Math.hypot(...values);
    },
  },
  {
    name: 'floor',
    category: 'rounding',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Round down to the nearest integer.',
    requirements: [],
    examples: [{ expression: 'floor(3.9)', result: '3' }],
    related: ['ceil', 'trunc', 'round'],
    evaluate: ({ values }) => Math.floor(values[0]!),
  },
  {
    name: 'ceil',
    category: 'rounding',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Round up to the nearest integer.',
    requirements: [],
    examples: [{ expression: 'ceil(3.1)', result: '4' }],
    related: ['floor', 'trunc', 'round'],
    evaluate: ({ values }) => Math.ceil(values[0]!),
  },
  {
    name: 'trunc',
    category: 'rounding',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Remove the fractional part of a value.',
    requirements: [],
    examples: [{ expression: 'trunc(-3.9)', result: '-3' }],
    related: ['floor', 'ceil', 'round'],
    evaluate: ({ values }) => Math.trunc(values[0]!),
  },
  {
    name: 'round',
    category: 'rounding',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Round to the nearest integer, with halves rounded away from zero.',
    requirements: [],
    examples: [{ expression: 'round(-1.5)', result: '-2' }],
    related: ['round_to', 'floor', 'ceil'],
    evaluate: ({ values }) => roundHalfAwayFromZero({ value: values[0]! }),
  },
  {
    name: 'round_to',
    category: 'rounding',
    arguments: { type: 'exact', names: ['value', 'digits'] },
    summary: 'Round to a decimal position, with halves rounded away from zero.',
    requirements: ['digits must be an integer from -100 through 100'],
    examples: [{ expression: 'round_to(12.3456, 2)', result: '12.35' }],
    related: ['round'],
    evaluate: ({ values, argumentSpans }) => {
      const [value, digits] = values as readonly [number, number];
      requireFiniteArgument({ value, span: argumentSpans[0]!, name: 'value' });
      if (!Number.isInteger(digits) || digits < -100 || digits > 100) {
        failCalculatorInput({
          code: 'invalid_argument',
          message: 'round_to requires digits to be an integer from -100 through 100.',
          span: argumentSpans[1],
          hint: undefined,
        });
      }
      if (digits >= 0 && Number.isInteger(value)) return value;
      const shifted = shiftDecimalExponent({ value, amount: digits });
      if (!Number.isFinite(shifted)) {
        failCalculatorInput({
          code: 'non_finite_result',
          message: 'round_to overflowed while shifting the decimal position.',
          span: argumentSpans[0],
          hint: 'Use a smaller value or fewer digits.',
        });
      }
      return shiftDecimalExponent({
        value: roundHalfAwayFromZero({ value: shifted }),
        amount: -digits,
      });
    },
  },
  {
    name: 'percent_of',
    category: 'percentages',
    arguments: { type: 'exact', names: ['percent', 'value'] },
    summary: 'Calculate a percentage of a value.',
    requirements: [],
    examples: [{ expression: 'percent_of(15, 240)', result: '36' }],
    related: ['increase_by_percent', 'decrease_by_percent', 'percent_change'],
    evaluate: ({ values }) => calculatePercentageOf({ percent: values[0]!, value: values[1]! }),
  },
  {
    name: 'increase_by_percent',
    category: 'percentages',
    arguments: { type: 'exact', names: ['value', 'percent'] },
    summary: 'Increase a value by a percentage.',
    requirements: [],
    examples: [{ expression: 'increase_by_percent(240, 15)', result: '276' }],
    related: ['percent_of', 'decrease_by_percent', 'percent_change'],
    evaluate: ({ values }) => values[0]! + calculatePercentageOf({ percent: values[1]!, value: values[0]! }),
  },
  {
    name: 'decrease_by_percent',
    category: 'percentages',
    arguments: { type: 'exact', names: ['value', 'percent'] },
    summary: 'Decrease a value by a percentage.',
    requirements: [],
    examples: [{ expression: 'decrease_by_percent(240, 15)', result: '204' }],
    related: ['percent_of', 'increase_by_percent', 'percent_change'],
    evaluate: ({ values }) => values[0]! - calculatePercentageOf({ percent: values[1]!, value: values[0]! }),
  },
  {
    name: 'percent_change',
    category: 'percentages',
    arguments: { type: 'exact', names: ['from', 'to'] },
    summary: 'Calculate the percentage change from one value to another.',
    requirements: [
      'from must not be zero',
      'the absolute starting value is used as the percentage baseline',
    ],
    examples: [{ expression: 'percent_change(200, 250)', result: '25' }],
    related: ['percent_of', 'increase_by_percent', 'decrease_by_percent'],
    evaluate: ({ values, argumentSpans }) => {
      if (values[0] === 0) {
        failCalculatorInput({
          code: 'division_by_zero',
          message: 'percent_change requires the starting value to be non-zero.',
          span: argumentSpans[0],
          hint: undefined,
        });
      }
      const baseline = Math.abs(values[0]!);
      return (values[1]! / baseline - values[0]! / baseline) * 100;
    },
  },
] as const satisfies readonly CalculatorFunctionDefinition[];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  calculatePercentageOf,
  roundHalfAwayFromZero,
  shiftDecimalExponent,
};
