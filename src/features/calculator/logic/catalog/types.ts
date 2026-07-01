import type { SourceSpan } from '@/features/calculator/logic/syntax';

export type CalculatorFunctionCategory =
  | 'arithmetic'
  | 'powers'
  | 'rounding'
  | 'logarithms'
  | 'trigonometry'
  | 'aggregation'
  | 'percentages'
  | 'integers';

export type CalculatorRuntime = {
  consumeOperations: ({ count, span }: {
    count: number,
    span: SourceSpan | undefined,
  }) => void,
};

export type CalculatorArgumentShape =
  | {
      readonly type: 'exact',
      readonly names: readonly string[],
    }
  | {
      readonly type: 'variadic',
      readonly requiredNames: readonly string[],
      readonly maximumCount: number,
    };

export type CalculatorFunctionDefinition = {
  readonly name: string,
  readonly category: CalculatorFunctionCategory,
  readonly arguments: CalculatorArgumentShape,
  readonly summary: string,
  readonly requirements: readonly string[],
  readonly examples: readonly {
    readonly expression: string,
    readonly result: string,
  }[],
  readonly related: readonly string[],
  readonly evaluate: ({ values, argumentSpans, callSpan, runtime }: {
    values: readonly number[],
    argumentSpans: readonly SourceSpan[],
    callSpan: SourceSpan,
    runtime: CalculatorRuntime,
  }) => number,
};

export type CalculatorConstantDefinition = {
  readonly name: string,
  readonly value: number,
  readonly summary: string,
};

export type CalculatorOperatorDefinition = {
  readonly symbol: string,
  readonly summary: string,
  readonly associativity: 'left' | 'right',
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
