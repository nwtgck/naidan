import {
  getCalculatorConstant,
  getCalculatorFunction,
  type CalculatorArgumentShape,
  type CalculatorRuntime,
} from './catalog';
import { failCalculatorInput } from './diagnostics';
import { CALCULATOR_LIMITS } from './limits';
import type { CalculatorExpression, SourceSpan } from './syntax';

function createCalculatorRuntime(): CalculatorRuntime {
  let remainingOperations = CALCULATOR_LIMITS.maximumOperations;
  return {
    consumeOperations: ({ count, span }) => {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`Invalid calculator operation cost: ${count}`);
      }
      remainingOperations -= count;
      if (remainingOperations < 0) {
        failCalculatorInput({
          code: 'limit_exceeded',
          message: `The calculation exceeds the operation budget of ${CALCULATOR_LIMITS.maximumOperations}.`,
          span,
          hint: 'Split the calculation into smaller expressions.',
        });
      }
    },
  };
}

function ensureFiniteResult({ value, span }: { value: number, span: SourceSpan }): number {
  if (!Number.isFinite(value)) {
    failCalculatorInput({
      code: 'non_finite_result',
      message: 'The calculation produced a non-finite result.',
      span,
      hint: 'Use smaller values or check the function domain.',
    });
  }
  return value;
}

function getArgumentCountRange({ shape }: {
  shape: CalculatorArgumentShape,
}): { minimum: number, maximum: number } {
  switch (shape.type) {
  case 'exact':
    return { minimum: shape.names.length, maximum: shape.names.length };
  case 'variadic':
    return { minimum: shape.requiredNames.length, maximum: shape.maximumCount };
  default: {
    const _exhaustive: never = shape;
    throw new Error(`Unhandled calculator argument shape: ${String(_exhaustive)}`);
  }
  }
}

function validateArgumentCount({
  functionName,
  shape,
  actual,
  span,
}: {
  functionName: string,
  shape: CalculatorArgumentShape,
  actual: number,
  span: SourceSpan,
}): void {
  const { minimum, maximum } = getArgumentCountRange({ shape });
  if (actual >= minimum && actual <= maximum) return;
  const expected = minimum === maximum
    ? String(minimum)
    : `${minimum} through ${maximum}`;
  failCalculatorInput({
    code: 'invalid_argument_count',
    message: `${functionName} expects ${expected} argument${maximum === 1 ? '' : 's'}, but received ${actual}.`,
    span,
    hint: `Evaluate \`help ${functionName}\` for usage.`,
  });
}

function evaluateExpression({
  expression,
  runtime,
  depth,
}: {
  expression: CalculatorExpression,
  runtime: CalculatorRuntime,
  depth: number,
}): number {
  if (depth > CALCULATOR_LIMITS.maximumEvaluationDepth) {
    failCalculatorInput({
      code: 'limit_exceeded',
      message: `The calculation exceeds the maximum evaluation depth of ${CALCULATOR_LIMITS.maximumEvaluationDepth}.`,
      span: expression.span,
      hint: 'Reduce nested functions, unary operators, or powers.',
    });
  }
  runtime.consumeOperations({ count: 1, span: expression.span });

  switch (expression.type) {
  case 'number':
    return expression.value;
  case 'identifier': {
    const constant = getCalculatorConstant({ name: expression.name });
    if (constant === undefined) {
      failCalculatorInput({
        code: 'unknown_identifier',
        message: `Unknown calculator constant: ${expression.name}.`,
        span: expression.span,
        hint: 'Evaluate `help constants` to list available constants.',
      });
    }
    return constant.value;
  }
  case 'unary': {
    const operand = evaluateExpression({ expression: expression.operand, runtime, depth: depth + 1 });
    switch (expression.operator) {
    case '+':
      return operand;
    case '-':
      return -operand;
    default: {
      const _exhaustive: never = expression.operator;
      throw new Error(`Unhandled calculator unary operator: ${String(_exhaustive)}`);
    }
    }
  }
  case 'power': {
    const base = evaluateExpression({ expression: expression.base, runtime, depth: depth + 1 });
    const exponent = evaluateExpression({ expression: expression.exponent, runtime, depth: depth + 1 });
    runtime.consumeOperations({ count: 1, span: expression.operatorSpan });
    return ensureFiniteResult({ value: Math.pow(base, exponent), span: expression.span });
  }
  case 'sequence': {
    let result = evaluateExpression({ expression: expression.head, runtime, depth: depth + 1 });
    for (const item of expression.tail) {
      const operand = evaluateExpression({ expression: item.operand, runtime, depth: depth + 1 });
      runtime.consumeOperations({ count: 1, span: item.operatorSpan });
      switch (item.operator) {
      case '+':
        result += operand;
        break;
      case '-':
        result -= operand;
        break;
      case '*':
        result *= operand;
        break;
      case '/':
        if (operand === 0) {
          failCalculatorInput({
            code: 'division_by_zero',
            message: 'Division by zero is not defined.',
            span: item.operatorSpan,
            hint: undefined,
          });
        }
        result /= operand;
        break;
      case '%':
        if (operand <= 0) {
          failCalculatorInput({
            code: 'invalid_argument',
            message: 'Modulo requires a positive divisor.',
            span: item.operand.span,
            hint: '`%` is modulo, not a percentage operator. Evaluate `help percentages` for percentage functions.',
          });
        }
        result = ((result % operand) + operand) % operand;
        break;
      default: {
        const _exhaustive: never = item.operator;
        throw new Error(`Unhandled calculator sequence operator: ${String(_exhaustive)}`);
      }
      }
      result = ensureFiniteResult({ value: result, span: expression.span });
    }
    return result;
  }
  case 'call': {
    const definition = getCalculatorFunction({ name: expression.name });
    if (definition === undefined) {
      failCalculatorInput({
        code: 'unknown_function',
        message: `Unknown calculator function: ${expression.name}.`,
        span: expression.nameSpan,
        hint: 'Evaluate `help` to list available functions.',
      });
    }
    validateArgumentCount({
      functionName: definition.name,
      shape: definition.arguments,
      actual: expression.arguments_.length,
      span: expression.nameSpan,
    });
    const values = expression.arguments_.map(argument => evaluateExpression({
      expression: argument,
      runtime,
      depth: depth + 1,
    }));
    const result = definition.evaluate({
      values,
      argumentSpans: expression.arguments_.map(argument => argument.span),
      callSpan: expression.span,
      runtime,
    });
    return ensureFiniteResult({ value: result, span: expression.span });
  }
  default: {
    const _exhaustive: never = expression;
    throw new Error(`Unhandled calculator expression: ${String(_exhaustive)}`);
  }
  }
}

export function evaluateCalculatorExpression({ expression }: {
  expression: CalculatorExpression,
}): number {
  return evaluateExpression({
    expression,
    runtime: createCalculatorRuntime(),
    depth: 1,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createCalculatorRuntime,
  getArgumentCountRange,
};
