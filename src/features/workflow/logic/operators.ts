import type { WorkflowValue } from '@/01-models/workflow';

type ArithmeticOperator = Extract<WorkflowValue, { type: 'arithmetic' }>['operator'];
type ComparisonOperator = Extract<WorkflowValue, { type: 'compare' }>['operator'];

/** Operators never coerce strings, null, or booleans. Numbers that cannot be
 * serialized as finite JSON numbers must fail before reaching a later step.
 */
export function calculateWorkflowNumber({ operator, left, right }: { operator: ArithmeticOperator, left: number, right: number }): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new Error('Arithmetic requires finite numbers.');
  }
  let result: number;
  switch (operator) {
  case 'add': result = left + right;
    break;
  case 'subtract': result = left - right;
    break;
  case 'multiply': result = left * right;
    break;
  case 'divide':
    if (right === 0) {
      throw new Error('Cannot divide by zero.');
    }
    result = left / right;
    break;
  case 'remainder':
    if (right === 0) {
      throw new Error('Cannot take a remainder with zero.');
    }
    result = left % right;
    break;
  default: {
    const exhaustive: never = operator;
    throw new Error(String(exhaustive));
  }
  }
  if (!Number.isFinite(result)) {
    throw new Error('Arithmetic produced a non-finite number.');
  }
  if (Number.isInteger(result) && !Number.isSafeInteger(result)) {
    throw new Error('Arithmetic exceeds safe integer precision.');
  }
  return result;
}

export function compareWorkflowNumbers({ operator, left, right }: { operator: ComparisonOperator, left: number, right: number }): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new Error('Comparison requires finite numbers.');
  }
  switch (operator) {
  case 'less': return left < right;
  case 'less_or_equal': return left <= right;
  case 'greater': return left > right;
  case 'greater_or_equal': return left >= right;
  default: {
    const exhaustive: never = operator;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
