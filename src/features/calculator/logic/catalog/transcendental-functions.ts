const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;

import { failCalculatorInput } from '@/features/calculator/logic/diagnostics';
import type { CalculatorFunctionDefinition } from './types';

function requirePositive({ value, span, functionName }: {
  value: number,
  span: { readonly start: number, readonly end: number },
  functionName: string,
}): void {
  if (value <= 0) {
    failCalculatorInput({
      code: 'domain_error',
      message: `${functionName} requires a value greater than zero.`,
      span,
      hint: undefined,
    });
  }
}

export const TRANSCENDENTAL_CALCULATOR_FUNCTIONS = [
  {
    name: 'exp',
    category: 'logarithms',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Calculate e raised to a power.',
    requirements: ['the result must be finite'],
    examples: [{ expression: 'exp(0)', result: '1' }],
    related: ['ln', 'log', 'log2', 'log10'],
    evaluate: ({ values }) => Math.exp(values[0]!),
  },
  {
    name: 'ln',
    category: 'logarithms',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Calculate the natural logarithm.',
    requirements: ['value must be greater than zero'],
    examples: [{ expression: 'ln(e)', result: '1' }],
    related: ['exp', 'log', 'log2', 'log10'],
    evaluate: ({ values, argumentSpans }) => {
      requirePositive({ value: values[0]!, span: argumentSpans[0]!, functionName: 'ln' });
      return Math.log(values[0]!);
    },
  },
  {
    name: 'log',
    category: 'logarithms',
    arguments: { type: 'exact', names: ['value', 'base'] },
    summary: 'Calculate a logarithm using an explicit base.',
    requirements: ['value must be greater than zero', 'base must be greater than zero and not equal to one'],
    examples: [{ expression: 'log(8, 2)', result: '3' }],
    related: ['ln', 'log2', 'log10', 'exp'],
    evaluate: ({ values, argumentSpans }) => {
      const [value, base] = values as readonly [number, number];
      requirePositive({ value, span: argumentSpans[0]!, functionName: 'log' });
      requirePositive({ value: base, span: argumentSpans[1]!, functionName: 'log base' });
      if (base === 1) {
        failCalculatorInput({
          code: 'domain_error',
          message: 'log requires a base other than one.',
          span: argumentSpans[1],
          hint: undefined,
        });
      }
      return Math.log(value) / Math.log(base);
    },
  },
  {
    name: 'log2',
    category: 'logarithms',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Calculate the base-2 logarithm.',
    requirements: ['value must be greater than zero'],
    examples: [{ expression: 'log2(1024)', result: '10' }],
    related: ['ln', 'log', 'log10'],
    evaluate: ({ values, argumentSpans }) => {
      requirePositive({ value: values[0]!, span: argumentSpans[0]!, functionName: 'log2' });
      return Math.log2(values[0]!);
    },
  },
  {
    name: 'log10',
    category: 'logarithms',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Calculate the base-10 logarithm.',
    requirements: ['value must be greater than zero'],
    examples: [{ expression: 'log10(1000)', result: '3' }],
    related: ['ln', 'log', 'log2'],
    evaluate: ({ values, argumentSpans }) => {
      requirePositive({ value: values[0]!, span: argumentSpans[0]!, functionName: 'log10' });
      return Math.log10(values[0]!);
    },
  },
  {
    name: 'sin',
    category: 'trigonometry',
    arguments: { type: 'exact', names: ['radians'] },
    summary: 'Calculate sine using radians.',
    requirements: [],
    examples: [{ expression: 'sin(pi / 2)', result: '1' }],
    related: ['cos', 'tan', 'asin', 'deg_to_rad'],
    evaluate: ({ values }) => Math.sin(values[0]!),
  },
  {
    name: 'cos',
    category: 'trigonometry',
    arguments: { type: 'exact', names: ['radians'] },
    summary: 'Calculate cosine using radians.',
    requirements: [],
    examples: [{ expression: 'cos(0)', result: '1' }],
    related: ['sin', 'tan', 'acos', 'deg_to_rad'],
    evaluate: ({ values }) => Math.cos(values[0]!),
  },
  {
    name: 'tan',
    category: 'trigonometry',
    arguments: { type: 'exact', names: ['radians'] },
    summary: 'Calculate tangent using radians.',
    requirements: ['the result must be finite'],
    examples: [{ expression: 'tan(0)', result: '0' }],
    related: ['sin', 'cos', 'atan', 'deg_to_rad'],
    evaluate: ({ values }) => Math.tan(values[0]!),
  },
  {
    name: 'asin',
    category: 'trigonometry',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Calculate inverse sine in radians.',
    requirements: ['value must be from -1 through 1'],
    examples: [{ expression: 'asin(1)', result: '1.570796326794897' }],
    related: ['sin', 'acos', 'atan'],
    evaluate: ({ values, argumentSpans }) => {
      const value = values[0]!;
      if (value < -1 || value > 1) {
        failCalculatorInput({ code: 'domain_error', message: 'asin requires a value from -1 through 1.', span: argumentSpans[0], hint: undefined });
      }
      return Math.asin(value);
    },
  },
  {
    name: 'acos',
    category: 'trigonometry',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Calculate inverse cosine in radians.',
    requirements: ['value must be from -1 through 1'],
    examples: [{ expression: 'acos(1)', result: '0' }],
    related: ['cos', 'asin', 'atan'],
    evaluate: ({ values, argumentSpans }) => {
      const value = values[0]!;
      if (value < -1 || value > 1) {
        failCalculatorInput({ code: 'domain_error', message: 'acos requires a value from -1 through 1.', span: argumentSpans[0], hint: undefined });
      }
      return Math.acos(value);
    },
  },
  {
    name: 'atan',
    category: 'trigonometry',
    arguments: { type: 'exact', names: ['value'] },
    summary: 'Calculate inverse tangent in radians.',
    requirements: [],
    examples: [{ expression: 'atan(1)', result: '0.7853981633974483' }],
    related: ['tan', 'atan2', 'asin', 'acos'],
    evaluate: ({ values }) => Math.atan(values[0]!),
  },
  {
    name: 'atan2',
    category: 'trigonometry',
    arguments: { type: 'exact', names: ['y', 'x'] },
    summary: 'Calculate the angle of the point (x, y) in radians.',
    requirements: [],
    examples: [{ expression: 'atan2(1, 1)', result: '0.7853981633974483' }],
    related: ['atan'],
    evaluate: ({ values }) => Math.atan2(values[0]!, values[1]!),
  },
  {
    name: 'deg_to_rad',
    category: 'trigonometry',
    arguments: { type: 'exact', names: ['degrees'] },
    summary: 'Convert degrees to radians.',
    requirements: [],
    examples: [{ expression: 'deg_to_rad(180)', result: '3.141592653589793' }],
    related: ['rad_to_deg', 'sin', 'cos', 'tan'],
    evaluate: ({ values }) => values[0]! * DEGREES_TO_RADIANS,
  },
  {
    name: 'rad_to_deg',
    category: 'trigonometry',
    arguments: { type: 'exact', names: ['radians'] },
    summary: 'Convert radians to degrees.',
    requirements: [],
    examples: [{ expression: 'rad_to_deg(pi)', result: '180' }],
    related: ['deg_to_rad'],
    evaluate: ({ values }) => values[0]! * RADIANS_TO_DEGREES,
  },
] as const satisfies readonly CalculatorFunctionDefinition[];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
