import { describe, it, expect, vi } from 'vitest';
import { createWorkflowExecutionControl, DEFAULT_WORKFLOW_EXECUTION_LIMITS, WorkflowExecutionLimitError } from './execution-control';

function clock() {
  vi.useFakeTimers();
  return {
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };
}

function control({ timeoutMs, signal }: { timeoutMs: number | undefined, signal: AbortSignal }) {
  const execution = createWorkflowExecutionControl({ limits: { ...DEFAULT_WORKFLOW_EXECUTION_LIMITS, timeoutMs }, signal });
  return {
    execution,
    [Symbol.dispose]() {
      execution.close();
    },
  };
}

describe('Workflow execution deadline ownership', () => {
  it('signals a pending operation when its deadline expires', async () => {
    using timer = clock();
    void timer;
    using owner = control({ timeoutMs: 100, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(99);
    expect(owner.execution.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(owner.execution.signal.reason).toBeInstanceOf(WorkflowExecutionLimitError);
    expect(() => owner.execution.check()).toThrow('time limit');
  });

  it('unhooks the parent and timer after completion without invalidating a completed run', async () => {
    using timer = clock();
    void timer;
    const parent = new AbortController();
    const removed = vi.spyOn(parent.signal, 'removeEventListener');
    using owner = control({ timeoutMs: 100, signal: parent.signal });
    owner.execution.close();
    parent.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(owner.execution.signal.aborted).toBe(false);
    removed.mockRestore();
  });

  it('preserves the first cancellation reason when timeout and user cancellation race', async () => {
    using timer = clock();
    void timer;
    const parent = new AbortController(), reason = new Error('User stop');
    using owner = control({ timeoutMs: 100, signal: parent.signal });
    parent.abort(reason);
    await vi.advanceTimersByTimeAsync(100);
    expect(owner.execution.signal.reason).toBe(reason);
  });
});
