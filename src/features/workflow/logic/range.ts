export type WorkflowNumberRange = { start: number, end: number | undefined, step: number };

export function validateWorkflowRange({ range }: { range: WorkflowNumberRange }): void {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.step) || range.step === 0 || (range.end !== undefined && !Number.isSafeInteger(range.end))) {
    throw new Error('A number range requires safe integers and a nonzero increment.');
  }
}

/** The end is exclusive. No array is allocated, including for an open-ended range.
 * Execution budgets and cancellation belong to the consumer, not the sequence.
 */
export function* workflowRangeItems({ range }: { range: WorkflowNumberRange }): Generator<number> {
  validateWorkflowRange({ range });
  const increment = BigInt(range.step);
  const end = range.end === undefined ? undefined : BigInt(range.end);
  for (let value = BigInt(range.start); end === undefined || (increment > 0 ? value < end : value > end); value += increment) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error('The number range exceeds safe integer precision.');
    }
    yield Number(value);
  }
}

export const TEST_ONLY = {
};
