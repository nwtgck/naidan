export type SourceSpan = {
  readonly start: number,
  readonly end: number,
};

export type CalculatorOperator = '+' | '-' | '*' | '/' | '%' | '^';

export type CalculatorToken =
  | {
      readonly type: 'number',
      readonly literal: string,
      readonly span: SourceSpan,
    }
  | {
      readonly type: 'identifier',
      readonly value: string,
      readonly span: SourceSpan,
    }
  | {
      readonly type: 'operator',
      readonly value: CalculatorOperator,
      readonly span: SourceSpan,
    }
  | {
      readonly type: 'left_parenthesis',
      readonly span: SourceSpan,
    }
  | {
      readonly type: 'right_parenthesis',
      readonly span: SourceSpan,
    }
  | {
      readonly type: 'comma',
      readonly span: SourceSpan,
    }
  | {
      readonly type: 'end',
      readonly span: SourceSpan,
    };

export type CalculatorExpression =
  | {
      readonly type: 'number',
      readonly literal: string,
      readonly span: SourceSpan,
    }
  | {
      readonly type: 'identifier',
      readonly name: string,
      readonly span: SourceSpan,
    }
  | {
      readonly type: 'unary',
      readonly operator: '+' | '-',
      readonly operand: CalculatorExpression,
      readonly span: SourceSpan,
    }
  | {
      readonly type: 'power',
      readonly base: CalculatorExpression,
      readonly exponent: CalculatorExpression,
      readonly operatorSpan: SourceSpan,
      readonly span: SourceSpan,
    }
  | {
      readonly type: 'sequence',
      readonly group: 'additive' | 'multiplicative',
      readonly head: CalculatorExpression,
      readonly tail: readonly {
        readonly operator: '+' | '-' | '*' | '/' | '%',
        readonly operatorSpan: SourceSpan,
        readonly operand: CalculatorExpression,
      }[],
      readonly span: SourceSpan,
    }
  | {
      readonly type: 'call',
      readonly name: string,
      readonly nameSpan: SourceSpan,
      readonly arguments_: readonly CalculatorExpression[],
      readonly span: SourceSpan,
    };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
