import type { WorkflowExecutionLimits } from '@/01-models/workflow';

export const DEFAULT_WORKFLOW_EXECUTION_LIMITS: Readonly<WorkflowExecutionLimits> = Object.freeze({
  maxLoopIterations: 10000,
  maxStepExecutions: 5000,
  maxValueEvaluations: 100000,
  timeoutMs: undefined,
});

export function workflowExecutionLimitIssues({ limits }: { limits: WorkflowExecutionLimits | undefined }): string[] {
  if (limits === undefined) {
    return [];
  }
  const { maxLoopIterations, maxStepExecutions, maxValueEvaluations, timeoutMs, ...unhandled } = limits;
  unhandled satisfies Record<PropertyKey, never>;
  const issues: string[] = [];
  for (const [name, value] of Object.entries({ maxLoopIterations, maxStepExecutions, maxValueEvaluations })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      issues.push(`${name} must be a nonnegative safe integer.`);
    }
  }
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)) {
    issues.push('timeoutMs must be an integer between 1 and 2147483647, or omitted.');
  }
  return issues;
}

export function resolveWorkflowExecutionLimits({ limits }: { limits: WorkflowExecutionLimits | undefined }): WorkflowExecutionLimits {
  const problems = workflowExecutionLimitIssues({ limits });
  if (problems.length) {
    throw new Error(problems.join('\n'));
  }
  return { ...(limits ?? DEFAULT_WORKFLOW_EXECUTION_LIMITS) };
}

export class WorkflowExecutionLimitError extends Error {
  constructor({ message }: { message: string }) {
    super(message);
    this.name = 'WorkflowExecutionLimitError';
  }
}

/** Budget exhaustion fails the run; user cancellation cancels it. An open-ended
 * sequence is not intrinsically invalid and does not allocate an infinite array.
 * Yielding to the host also lets the Stop button interrupt purely in-memory loops.
 */
export function createWorkflowExecutionControl({ limits, signal: parentSignal }: { limits: WorkflowExecutionLimits, signal: AbortSignal }) {
  const resolved = resolveWorkflowExecutionLimits({ limits });
  const controller = new AbortController();
  const abort = (): void => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', abort, { once: true });
  if (parentSignal.aborted) {
    abort();
  }
  const started = performance.now();
  let lastYield = started;
  const deadline = resolved.timeoutMs === undefined ? undefined : started + resolved.timeoutMs;
  const fail = ({ message }: { message: string }): never => {
    const error = new WorkflowExecutionLimitError({ message });
    controller.abort(error);
    throw error;
  };
  const timeout = resolved.timeoutMs === undefined ? undefined : setTimeout(() => {
    controller.abort(new WorkflowExecutionLimitError({ message: 'Workflow time limit exceeded.' }));
  }, resolved.timeoutMs);
  let iterations = 0, steps = 0, evaluations = 0;
  const check = (): void => {
    controller.signal.throwIfAborted();
    if (deadline !== undefined && performance.now() >= deadline) {
      fail({ message: 'Workflow time limit exceeded.' });
    }
  };
  return {
    signal: controller.signal,
    check,
    evaluate(): void {
      check();
      if (evaluations >= resolved.maxValueEvaluations) {
        fail({ message: `Workflow exceeded ${resolved.maxValueEvaluations} value evaluations.` });
      }
      evaluations++;
    },
    step(): void {
      check();
      if (steps >= resolved.maxStepExecutions) {
        fail({ message: `Workflow exceeded ${resolved.maxStepExecutions} step executions.` });
      }
      steps++;
    },
    iteration(): void {
      check();
      if (iterations >= resolved.maxLoopIterations) {
        fail({ message: `Workflow exceeded ${resolved.maxLoopIterations} total loop iterations.` });
      }
      iterations++;
    },
    async yieldToHost(): Promise<void> {
      check();
      if (performance.now() - lastYield >= 16) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        lastYield = performance.now();
        check();
      }
    },
    close(): void {
      parentSignal.removeEventListener('abort', abort);
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    },
  };
}

export const TEST_ONLY = {
};
