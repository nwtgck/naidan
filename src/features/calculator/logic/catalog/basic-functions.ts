import { failCalculatorInput } from '@/features/calculator/logic/diagnostics';
import { CALCULATOR_LIMITS } from '@/features/calculator/logic/limits';
import {
  absoluteNumericValue,
  addNumericValues,
  compareNumericValues,
  divideNumericValues,
  integerFromNumericValue,
  multiplyNumericValues,
  numericValueFromBigInt,
  powerNumericValue,
  propagateApproximateInputs,
  rootNumericValue,
  roundNumericValueToDecimalPlaces,
  signResultNumericValue,
  subtractNumericValues,
  truncateNumericValueToInteger,
} from '@/features/calculator/logic/numeric/numeric-value';
import { CALCULATOR_PI_VALUE } from './constants';
import type { CalculatorFunctionDefinition } from './types';

const ZERO = numericValueFromBigInt({ value: 0n });
const ONE_HUNDRED = numericValueFromBigInt({ value: 100n });
const ONE_HUNDRED_EIGHTY = numericValueFromBigInt({ value: 180n });
const PI = CALCULATOR_PI_VALUE;

export const BASIC_CALCULATOR_FUNCTIONS = [
  {
    name: 'abs', category: 'arithmetic', arguments: { type: 'exact', names: ['value'] }, precision: 'conditional',
    summary: 'Return the absolute value while preserving the input exactness.', requirements: [],
    examples: [{ expression: 'abs(-12.5)', result: '12.5', exactness: 'rational' }], related: ['sign'],
    evaluate: ({ values }) => absoluteNumericValue({ value: values[0]! }),
  },
  {
    name: 'sign', category: 'arithmetic', arguments: { type: 'exact', names: ['value'] }, precision: 'conditional',
    summary: 'Return -1, 0, or 1 while preserving whether the input was approximate.', requirements: [],
    examples: [{ expression: 'sign(-8)', result: '-1', exactness: 'rational' }], related: ['abs'],
    evaluate: ({ values }) => signResultNumericValue({ value: values[0]! }),
  },
  {
    name: 'clamp', category: 'arithmetic', arguments: { type: 'exact', names: ['value', 'minimum', 'maximum'] }, precision: 'conditional',
    summary: 'Restrict a value to an inclusive range.', requirements: ['minimum must not be greater than maximum'],
    examples: [{ expression: 'clamp(120, 0, 100)', result: '100', exactness: 'rational' }], related: ['min', 'max'],
    evaluate: ({ values, argumentSpans }) => {
      const [value, minimum, maximum] = values as readonly [typeof values[number], typeof values[number], typeof values[number]];
      if (compareNumericValues({ left: minimum, right: maximum }) > 0) {
        failCalculatorInput({
          code: 'invalid_argument',
          message: 'clamp requires minimum to be less than or equal to maximum.',
          span: argumentSpans[1],
          hint: undefined,
        });
      }
      const selected = compareNumericValues({ left: value, right: minimum }) < 0
        ? minimum
        : compareNumericValues({ left: value, right: maximum }) > 0
          ? maximum
          : value;
      return propagateApproximateInputs({ value: selected, inputs: values });
    },
  },
  {
    name: 'sqrt', category: 'powers', arguments: { type: 'exact', names: ['value'] }, precision: 'conditional',
    summary: 'Calculate the principal square root; perfect rational roots remain exact.', requirements: ['value must be non-negative'],
    examples: [{ expression: 'sqrt(81)', result: '9', exactness: 'rational' }], related: ['cbrt', 'pow', 'hypot'],
    evaluate: ({ values, argumentSpans, runtime }) => rootNumericValue({ value: values[0]!, degree: 2, span: argumentSpans[0]!, runtime }),
  },
  {
    name: 'cbrt', category: 'powers', arguments: { type: 'exact', names: ['value'] }, precision: 'conditional',
    summary: 'Calculate the real cube root; perfect rational roots remain exact.', requirements: [],
    examples: [{ expression: 'cbrt(-27)', result: '-3', exactness: 'rational' }], related: ['sqrt', 'pow'],
    evaluate: ({ values, argumentSpans, runtime }) => rootNumericValue({ value: values[0]!, degree: 3, span: argumentSpans[0]!, runtime }),
  },
  {
    name: 'pow', category: 'powers', arguments: { type: 'exact', names: ['value', 'exponent'] }, precision: 'conditional',
    summary: 'Raise a value to an exact integer exponent.', requirements: ['exponent must be an exact integer'],
    examples: [{ expression: 'pow(2, -3)', result: '0.125', exactness: 'rational' }], related: ['sqrt', 'cbrt'],
    evaluate: ({ values, argumentSpans, callSpan, runtime }) => powerNumericValue({
      base: values[0]!, exponentValue: values[1]!, exponentSpan: argumentSpans[1]!, operatorSpan: callSpan, runtime,
    }),
  },
  {
    name: 'hypot', category: 'powers',
    arguments: { type: 'variadic', requiredNames: ['value'], maximumCount: CALCULATOR_LIMITS.maximumFunctionArgumentCount },
    precision: 'conditional', summary: 'Calculate the square root of the sum of squared values.', requirements: [],
    examples: [{ expression: 'hypot(3, 4)', result: '5', exactness: 'rational' }], related: ['sqrt'],
    evaluate: ({ values, callSpan, runtime }) => {
      let sum = ZERO;
      for (const value of values) {
        runtime.consumeOperations({ count: 1, span: callSpan });
        sum = addNumericValues({ left: sum, right: multiplyNumericValues({ left: value, right: value }) });
      }
      return rootNumericValue({ value: sum, degree: 2, span: callSpan, runtime });
    },
  },
  {
    name: 'floor', category: 'rounding', arguments: { type: 'exact', names: ['value'] }, precision: 'conditional',
    summary: 'Round down to the nearest integer.', requirements: [],
    examples: [{ expression: 'floor(-1.2)', result: '-2', exactness: 'rational' }], related: ['ceil', 'trunc', 'round'],
    evaluate: ({ values }) => truncateNumericValueToInteger({ value: values[0]!, mode: 'floor' }),
  },
  {
    name: 'ceil', category: 'rounding', arguments: { type: 'exact', names: ['value'] }, precision: 'conditional',
    summary: 'Round up to the nearest integer.', requirements: [],
    examples: [{ expression: 'ceil(1.2)', result: '2', exactness: 'rational' }], related: ['floor', 'trunc', 'round'],
    evaluate: ({ values }) => truncateNumericValueToInteger({ value: values[0]!, mode: 'ceil' }),
  },
  {
    name: 'trunc', category: 'rounding', arguments: { type: 'exact', names: ['value'] }, precision: 'conditional',
    summary: 'Discard the fractional part.', requirements: [],
    examples: [{ expression: 'trunc(-1.8)', result: '-1', exactness: 'rational' }], related: ['floor', 'ceil', 'round'],
    evaluate: ({ values }) => truncateNumericValueToInteger({ value: values[0]!, mode: 'trunc' }),
  },
  {
    name: 'round', category: 'rounding', arguments: { type: 'exact', names: ['value'] }, precision: 'conditional',
    summary: 'Round to the nearest integer with halves away from zero.', requirements: [],
    examples: [{ expression: 'round(-1.5)', result: '-2', exactness: 'rational' }], related: ['round_to', 'floor', 'ceil'],
    evaluate: ({ values }) => truncateNumericValueToInteger({ value: values[0]!, mode: 'round_half_away' }),
  },
  {
    name: 'round_to', category: 'rounding', arguments: { type: 'exact', names: ['value', 'decimal_places'] }, precision: 'conditional',
    summary: 'Round to a number of decimal places with halves away from zero.',
    requirements: [`decimal_places must be an exact integer between -${CALCULATOR_LIMITS.maximumAlignmentDigits} and ${CALCULATOR_LIMITS.maximumAlignmentDigits}`],
    examples: [{ expression: 'round_to(12.345, 2)', result: '12.35', exactness: 'rational' }], related: ['round'],
    evaluate: ({ values, argumentSpans }) => {
      const places = integerFromNumericValue({ value: values[1]!, name: 'decimal_places', span: argumentSpans[1]! });
      const maximum = BigInt(CALCULATOR_LIMITS.maximumAlignmentDigits);
      if (places < -maximum || places > maximum) {
        failCalculatorInput({
          code: 'limit_exceeded',
          message: `decimal_places must be between -${maximum} and ${maximum}.`,
          span: argumentSpans[1],
          hint: undefined,
        });
      }
      return roundNumericValueToDecimalPlaces({ value: values[0]!, decimalPlaces: Number(places) });
    },
  },
  {
    name: 'percent_of', category: 'percentages', arguments: { type: 'exact', names: ['percent', 'value'] }, precision: 'conditional',
    summary: 'Calculate a percentage of a value.', requirements: [],
    examples: [{ expression: 'percent_of(15, 240)', result: '36', exactness: 'rational' }],
    related: ['increase_by_percent', 'decrease_by_percent', 'percent_change'],
    evaluate: ({ values, callSpan }) => multiplyNumericValues({
      left: divideNumericValues({ numerator: values[0]!, denominator: ONE_HUNDRED, span: callSpan }),
      right: values[1]!,
    }),
  },
  {
    name: 'increase_by_percent', category: 'percentages', arguments: { type: 'exact', names: ['value', 'percent'] }, precision: 'conditional',
    summary: 'Increase a value by a percentage.', requirements: [],
    examples: [{ expression: 'increase_by_percent(240, 15)', result: '276', exactness: 'rational' }],
    related: ['percent_of', 'decrease_by_percent', 'percent_change'],
    evaluate: ({ values, callSpan }) => addNumericValues({
      left: values[0]!,
      right: multiplyNumericValues({
        left: divideNumericValues({ numerator: values[1]!, denominator: ONE_HUNDRED, span: callSpan }),
        right: values[0]!,
      }),
    }),
  },
  {
    name: 'decrease_by_percent', category: 'percentages', arguments: { type: 'exact', names: ['value', 'percent'] }, precision: 'conditional',
    summary: 'Decrease a value by a percentage.', requirements: [],
    examples: [{ expression: 'decrease_by_percent(240, 15)', result: '204', exactness: 'rational' }],
    related: ['percent_of', 'increase_by_percent', 'percent_change'],
    evaluate: ({ values, callSpan }) => subtractNumericValues({
      left: values[0]!,
      right: multiplyNumericValues({
        left: divideNumericValues({ numerator: values[1]!, denominator: ONE_HUNDRED, span: callSpan }),
        right: values[0]!,
      }),
    }),
  },
  {
    name: 'percent_change', category: 'percentages', arguments: { type: 'exact', names: ['from', 'to'] }, precision: 'conditional',
    summary: 'Calculate percentage change relative to the absolute starting value.', requirements: ['from must not be zero'],
    examples: [{ expression: 'percent_change(200, 250)', result: '25', exactness: 'rational' }],
    related: ['percent_of', 'increase_by_percent', 'decrease_by_percent'],
    evaluate: ({ values, callSpan, argumentSpans }) => {
      if (compareNumericValues({ left: values[0]!, right: ZERO }) === 0) {
        failCalculatorInput({
          code: 'division_by_zero', message: 'percent_change requires a non-zero starting value.',
          span: argumentSpans[0], hint: undefined,
        });
      }
      return multiplyNumericValues({
        left: divideNumericValues({
          numerator: subtractNumericValues({ left: values[1]!, right: values[0]! }),
          denominator: absoluteNumericValue({ value: values[0]! }),
          span: callSpan,
        }),
        right: ONE_HUNDRED,
      });
    },
  },
  {
    name: 'deg_to_rad', category: 'angles', arguments: { type: 'exact', names: ['degrees'] }, precision: 'approximate',
    summary: 'Convert degrees to radians using the bounded pi constant.', requirements: [],
    examples: [{ expression: 'deg_to_rad(180)', result: '3.14159265358979', exactness: 'approximate' }], related: ['rad_to_deg'],
    evaluate: ({ values, callSpan }) => divideNumericValues({
      numerator: multiplyNumericValues({ left: values[0]!, right: PI }),
      denominator: ONE_HUNDRED_EIGHTY,
      span: callSpan,
    }),
  },
  {
    name: 'rad_to_deg', category: 'angles', arguments: { type: 'exact', names: ['radians'] }, precision: 'approximate',
    summary: 'Convert radians to degrees using the bounded pi constant.', requirements: [],
    examples: [{ expression: 'rad_to_deg(pi)', result: '180', exactness: 'approximate' }], related: ['deg_to_rad'],
    evaluate: ({ values, callSpan }) => divideNumericValues({
      numerator: multiplyNumericValues({ left: values[0]!, right: ONE_HUNDRED_EIGHTY }),
      denominator: PI,
      span: callSpan,
    }),
  },
] as const satisfies readonly CalculatorFunctionDefinition[];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
