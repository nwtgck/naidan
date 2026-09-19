import { describe, expect, it, vi } from 'vitest';
import { runInvestigationTargetsSequentially } from '@/features/transformers-js/model-support-investigation/logic/run-investigation-targets-sequentially';
import type { ModelSupportInvestigationRun } from '@/features/transformers-js/model-support-investigation/types';

function run({ modelId, status }: { modelId: string, status: 'passed' | 'failed' }): ModelSupportInvestigationRun {
  return {
    schemaVersion: 1,
    runId: `run-${modelId}`,
    modelId,
    scope: 'partial-runtime-preflight',
    startedAt: '2026-09-05T00:00:00.000Z',
    completedAt: '2026-09-05T00:00:01.000Z',
    status,
    currentOperation: 'done',
    steps: [],
    runtimeAssets: undefined,
    repository: undefined,
    runtimeTarget: undefined,
    downloadEvidence: undefined,
    cache: undefined,
    declarations: undefined,
    templateBehavior: undefined,
    modelFilePlan: undefined,
    loadAttempts: [],
    activeLoadAttempt: undefined,
    productionLane: { status: 'not-run', observation: undefined, partialObservation: undefined, error: undefined },
    laneComparison: undefined,
    error: status === 'failed' ? 'fixture failure' : undefined,
  };
}

describe('runInvestigationTargetsSequentially', () => {
  it('continues to later models after a failed model and never overlaps target execution', async () => {
    const active: string[] = [];
    const calls: string[] = [];
    const runTarget = vi.fn(async ({ target }: { target: string }) => {
      expect(active).toEqual([]);
      active.push(target);
      calls.push(`start:${target}`);
      const result = run({ modelId: target, status: target === 'owner/b' ? 'failed' : 'passed' });
      active.pop();
      calls.push(`finish:${target}`);
      return result;
    });

    const executions = await runInvestigationTargetsSequentially({
      targets: ['owner/a', 'owner/b', 'owner/c'],
      runTarget,
      onUpdate: () => undefined,
      shouldInterrupt: () => false,
      takeSkipRequest: () => false,
    });

    expect(calls).toEqual([
      'start:owner/a', 'finish:owner/a',
      'start:owner/b', 'finish:owner/b',
      'start:owner/c', 'finish:owner/c',
    ]);
    expect(executions.map(({ target, status }) => ({ target, status }))).toEqual([
      { target: 'owner/a', status: 'passed' },
      { target: 'owner/b', status: 'failed' },
      { target: 'owner/c', status: 'passed' },
    ]);
  });

  it('stops before the next model after an interruption is requested', async () => {
    let interrupt = false;
    const runTarget = vi.fn(async ({ target }: { target: string }) => {
      interrupt = true;
      throw new Error(`interrupted ${target}`);
    });

    const executions = await runInvestigationTargetsSequentially({
      targets: ['owner/a', 'owner/b'],
      runTarget,
      onUpdate: () => undefined,
      shouldInterrupt: () => interrupt,
      takeSkipRequest: () => false,
    });

    expect(runTarget).toHaveBeenCalledTimes(1);
    expect(executions.map(({ status }) => status)).toEqual(['interrupted', 'pending']);
  });


  it('marks only the current model as skipped and continues with the next model', async () => {
    let skippedTarget: string | undefined = 'owner/b';
    const runTarget = vi.fn(async ({ target }: { target: string }) => {
      if (target === 'owner/b') throw new Error('stopped current model');
      return run({ modelId: target, status: 'passed' });
    });

    const executions = await runInvestigationTargetsSequentially({
      targets: ['owner/a', 'owner/b', 'owner/c'],
      runTarget,
      onUpdate: () => undefined,
      shouldInterrupt: () => false,
      takeSkipRequest: ({ target }) => {
        if (skippedTarget !== target) return false;
        skippedTarget = undefined;
        return true;
      },
    });

    expect(runTarget).toHaveBeenCalledTimes(3);
    expect(executions.map(({ target, status }) => ({ target, status }))).toEqual([
      { target: 'owner/a', status: 'passed' },
      { target: 'owner/b', status: 'skipped' },
      { target: 'owner/c', status: 'passed' },
    ]);
  });

  it('keeps the last checkpointed run when one target throws and later targets continue', async () => {
    const partial = run({ modelId: 'owner/b', status: 'failed' });
    partial.currentOperation = 'last checkpoint before worker failure';
    const runTarget = vi.fn(async ({ target }: { target: string }) => {
      if (target === 'owner/b') throw new Error('worker crashed');
      return run({ modelId: target, status: 'passed' });
    });

    const executions = await runInvestigationTargetsSequentially({
      targets: ['owner/a', 'owner/b', 'owner/c'],
      runTarget,
      onUpdate: () => undefined,
      shouldInterrupt: () => false,
      takeSkipRequest: () => false,
      recoverRunAfterError: ({ target }) => target === 'owner/b' ? partial : undefined,
    });

    expect(executions[1]).toMatchObject({
      target: 'owner/b',
      status: 'failed',
      error: 'worker crashed',
      run: { currentOperation: 'last checkpoint before worker failure' },
    });
    expect(executions[2]?.status).toBe('passed');
  });
});
