import { failCalculatorInput } from './diagnostics';
import { CALCULATOR_LIMITS } from './limits';
import type { CalculatorExpression, CalculatorToken, SourceSpan } from './syntax';

type ParserState = {
  readonly tokens: readonly CalculatorToken[],
  tokenIndex: number,
  astItemCount: number,
};

function currentToken({ state }: { state: ParserState }): CalculatorToken {
  return state.tokens[state.tokenIndex] ?? state.tokens[state.tokens.length - 1]!;
}

function advanceToken({ state }: { state: ParserState }): CalculatorToken {
  const token = currentToken({ state });
  state.tokenIndex += 1;
  return token;
}


function isLeftParenthesisToken(token: CalculatorToken): token is Extract<CalculatorToken, { readonly type: 'left_parenthesis' }> {
  switch (token.type) {
  case 'left_parenthesis':
    return true;
  case 'number':
  case 'identifier':
  case 'operator':
  case 'right_parenthesis':
  case 'comma':
  case 'end':
    return false;
  default: {
    const _exhaustive: never = token;
    throw new Error(`Unhandled calculator token: ${String(_exhaustive)}`);
  }
  }
}

function isRightParenthesisToken(token: CalculatorToken): token is Extract<CalculatorToken, { readonly type: 'right_parenthesis' }> {
  switch (token.type) {
  case 'right_parenthesis':
    return true;
  case 'number':
  case 'identifier':
  case 'operator':
  case 'left_parenthesis':
  case 'comma':
  case 'end':
    return false;
  default: {
    const _exhaustive: never = token;
    throw new Error(`Unhandled calculator token: ${String(_exhaustive)}`);
  }
  }
}

function isCommaToken(token: CalculatorToken): token is Extract<CalculatorToken, { readonly type: 'comma' }> {
  switch (token.type) {
  case 'comma':
    return true;
  case 'number':
  case 'identifier':
  case 'operator':
  case 'left_parenthesis':
  case 'right_parenthesis':
  case 'end':
    return false;
  default: {
    const _exhaustive: never = token;
    throw new Error(`Unhandled calculator token: ${String(_exhaustive)}`);
  }
  }
}

function isEndToken(token: CalculatorToken): token is Extract<CalculatorToken, { readonly type: 'end' }> {
  switch (token.type) {
  case 'end':
    return true;
  case 'number':
  case 'identifier':
  case 'operator':
  case 'left_parenthesis':
  case 'right_parenthesis':
  case 'comma':
    return false;
  default: {
    const _exhaustive: never = token;
    throw new Error(`Unhandled calculator token: ${String(_exhaustive)}`);
  }
  }
}

function registerAstItem({ state, span }: { state: ParserState, span: SourceSpan }): void {
  state.astItemCount += 1;
  if (state.astItemCount > CALCULATOR_LIMITS.maximumAstItemCount) {
    failCalculatorInput({
      code: 'limit_exceeded',
      message: `The expression exceeds the maximum of ${CALCULATOR_LIMITS.maximumAstItemCount} syntax items.`,
      span,
      hint: 'Split the calculation into smaller expressions.',
    });
  }
}

function checkDepth({ depth, span }: { depth: number, span: SourceSpan }): void {
  if (depth > CALCULATOR_LIMITS.maximumSyntaxDepth) {
    failCalculatorInput({
      code: 'limit_exceeded',
      message: `The expression exceeds the maximum syntax depth of ${CALCULATOR_LIMITS.maximumSyntaxDepth}.`,
      span,
      hint: 'Reduce nested parentheses, unary operators, or powers.',
    });
  }
}

function expressionSpan({ start, end }: { start: CalculatorExpression, end: CalculatorExpression }): SourceSpan {
  return { start: start.span.start, end: end.span.end };
}

function parseExpression({ state, depth }: { state: ParserState, depth: number }): CalculatorExpression {
  return parseAdditive({ state, depth });
}

function parseAdditive({ state, depth }: { state: ParserState, depth: number }): CalculatorExpression {
  const head = parseMultiplicative({ state, depth });
  const tail: Array<{
    readonly operator: '+' | '-',
    readonly operatorSpan: SourceSpan,
    readonly operand: CalculatorExpression,
  }> = [];
  while (true) {
    const token = currentToken({ state });
    if (token.type !== 'operator' || (token.value !== '+' && token.value !== '-')) break;
    advanceToken({ state });
    const operand = parseMultiplicative({ state, depth });
    tail.push({ operator: token.value, operatorSpan: token.span, operand });
    registerAstItem({ state, span: token.span });
  }
  if (tail.length === 0) return head;
  const last = tail[tail.length - 1]!;
  return {
    type: 'sequence',
    group: 'additive',
    head,
    tail,
    span: expressionSpan({ start: head, end: last.operand }),
  };
}

function parseMultiplicative({ state, depth }: { state: ParserState, depth: number }): CalculatorExpression {
  const head = parseUnary({ state, depth });
  const tail: Array<{
    readonly operator: '*' | '/' | '%',
    readonly operatorSpan: SourceSpan,
    readonly operand: CalculatorExpression,
  }> = [];
  while (true) {
    const token = currentToken({ state });
    if (token.type !== 'operator' || (token.value !== '*' && token.value !== '/' && token.value !== '%')) break;
    advanceToken({ state });
    const operand = parseUnary({ state, depth });
    tail.push({ operator: token.value, operatorSpan: token.span, operand });
    registerAstItem({ state, span: token.span });
  }
  if (tail.length === 0) return head;
  const last = tail[tail.length - 1]!;
  return {
    type: 'sequence',
    group: 'multiplicative',
    head,
    tail,
    span: expressionSpan({ start: head, end: last.operand }),
  };
}

function parseUnary({ state, depth }: { state: ParserState, depth: number }): CalculatorExpression {
  const token = currentToken({ state });
  checkDepth({ depth, span: token.span });
  if (token.type === 'operator' && (token.value === '+' || token.value === '-')) {
    advanceToken({ state });
    const operand = parseUnary({ state, depth: depth + 1 });
    registerAstItem({ state, span: token.span });
    return {
      type: 'unary',
      operator: token.value,
      operand,
      span: { start: token.span.start, end: operand.span.end },
    };
  }
  return parsePower({ state, depth });
}

function parsePower({ state, depth }: { state: ParserState, depth: number }): CalculatorExpression {
  const base = parsePrimary({ state, depth });
  const token = currentToken({ state });
  if (token.type !== 'operator' || token.value !== '^') return base;
  advanceToken({ state });
  const exponent = parseUnary({ state, depth: depth + 1 });
  registerAstItem({ state, span: token.span });
  return {
    type: 'power',
    base,
    exponent,
    operatorSpan: token.span,
    span: expressionSpan({ start: base, end: exponent }),
  };
}

function parsePrimary({ state, depth }: { state: ParserState, depth: number }): CalculatorExpression {
  const token = currentToken({ state });
  checkDepth({ depth, span: token.span });
  switch (token.type) {
  case 'number':
    advanceToken({ state });
    registerAstItem({ state, span: token.span });
    return { type: 'number', literal: token.literal, span: token.span };
  case 'identifier': {
    advanceToken({ state });
    const next = currentToken({ state });
    if (!isLeftParenthesisToken(next)) {
      registerAstItem({ state, span: token.span });
      return { type: 'identifier', name: token.value, span: token.span };
    }
    advanceToken({ state });
    const arguments_: CalculatorExpression[] = [];
    if (!isRightParenthesisToken(currentToken({ state }))) {
      while (true) {
        if (arguments_.length >= CALCULATOR_LIMITS.maximumFunctionArgumentCount) {
          failCalculatorInput({
            code: 'limit_exceeded',
            message: `A function call exceeds the maximum of ${CALCULATOR_LIMITS.maximumFunctionArgumentCount} arguments.`,
            span: currentToken({ state }).span,
            hint: 'Split the calculation into smaller function calls.',
          });
        }
        arguments_.push(parseExpression({ state, depth: depth + 1 }));
        const separator = currentToken({ state });
        if (!isCommaToken(separator)) break;
        advanceToken({ state });
        if (isRightParenthesisToken(currentToken({ state }))) {
          failCalculatorInput({
            code: 'unexpected_token',
            message: 'A trailing comma is not allowed in a function call.',
            span: separator.span,
            hint: 'Remove the comma or add another argument.',
          });
        }
      }
    }
    const closing = currentToken({ state });
    if (!isRightParenthesisToken(closing)) {
      failCalculatorInput({
        code: 'missing_token',
        message: `Expected ")" after the arguments to ${token.value}.`,
        span: closing.span,
        hint: undefined,
      });
    }
    advanceToken({ state });
    registerAstItem({ state, span: token.span });
    return {
      type: 'call',
      name: token.value,
      nameSpan: token.span,
      arguments_,
      span: { start: token.span.start, end: closing.span.end },
    };
  }
  case 'left_parenthesis': {
    advanceToken({ state });
    if (isRightParenthesisToken(currentToken({ state }))) {
      failCalculatorInput({
        code: 'unexpected_token',
        message: 'Empty parentheses are not a numeric expression.',
        span: currentToken({ state }).span,
        hint: 'Place an expression inside the parentheses.',
      });
    }
    const expression = parseExpression({ state, depth: depth + 1 });
    const closing = currentToken({ state });
    if (!isRightParenthesisToken(closing)) {
      failCalculatorInput({
        code: 'missing_token',
        message: 'Expected ")" to close the parenthesized expression.',
        span: closing.span,
        hint: undefined,
      });
    }
    advanceToken({ state });
    return expression;
  }
  case 'operator':
  case 'right_parenthesis':
  case 'comma':
  case 'end':
    return failCalculatorInput({
      code: 'unexpected_token',
      message: 'Expected a number, constant, function call, or parenthesized expression.',
      span: token.span,
      hint: 'Evaluate `help syntax` for examples.',
    });
  default: {
    const _exhaustive: never = token;
    throw new Error(`Unhandled calculator token: ${String(_exhaustive)}`);
  }
  }
}

export function parseCalculatorTokens({ tokens }: {
  tokens: readonly CalculatorToken[],
}): CalculatorExpression {
  const state: ParserState = {
    tokens,
    tokenIndex: 0,
    astItemCount: 0,
  };
  const expression = parseExpression({ state, depth: 1 });
  const trailing = currentToken({ state });
  if (!isEndToken(trailing)) {
    const implicitMultiplicationHint = (() => {
      switch (trailing.type) {
      case 'identifier':
      case 'left_parenthesis':
        return 'Use an explicit `*` for multiplication, such as `2 * pi`.';
      case 'number':
      case 'operator':
      case 'right_parenthesis':
      case 'comma':
        return undefined;
      default: {
        const _exhaustive: never = trailing;
        throw new Error(`Unhandled calculator trailing token: ${String(_exhaustive)}`);
      }
      }
    })();
    failCalculatorInput({
      code: 'unexpected_token',
      message: 'Unexpected input after the end of the expression.',
      span: trailing.span,
      hint: implicitMultiplicationHint,
    });
  }
  return expression;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
