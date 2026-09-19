// @vitest-environment node
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { investigationExecutionSummary } from './investigation-execution-summary';
import { createInitialInvestigationCheckpoint } from './investigation-recovery';
import { createPartialModelSupportEvidence } from './create-partial-evidence';

describe('investigation execution versus evidence coverage', () => {
  it.each(['running', 'completed', 'interrupted', 'unknown'] as const)('exports %s without deriving completion from a passed boundary or a valid ZIP', async state => {
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'fixture/execution', runId: 'execution', now: () => '2026-09-08T00:00:00.000Z' });
    checkpoint.run.status = 'passed';
    const recovery = state === 'unknown' ? undefined : {
      ...checkpoint.recovery, status: state, checkpointedAt: '2026-09-08T00:00:01.000Z',
    };
    const execution = investigationExecutionSummary({ run: checkpoint.run, recovery });
    expect(execution).toEqual(state === 'completed'
      ? { schemaVersion: 1, state, result: 'passed', completedAt: '2026-09-08T00:00:01.000Z' }
      : { schemaVersion: 1, state });
    const { blob } = await createPartialModelSupportEvidence({ run: checkpoint.run, recovery });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(JSON.parse(await zip.file('execution.json')!.async('string'))).toEqual(execution);
    const summary = await zip.file('SUMMARY.md')!.async('string');
    expect(summary).toContain(`Execution: ${state}`);
    expect(summary).toContain('coverage, not execution status');
    expect(summary).toContain('Unselected scopes are not pending work');
    expect(summary).toContain('No real-model load attempts were recorded.');
    expect(summary).not.toContain('not investigated by this build');
    expect(summary).toContain(`Completed execution: ${state === 'completed' ? recovery?.checkpointedAt : 'not-recorded'}`);
    // Exporting has no authority to change the caller's live checkpoint.
    expect(checkpoint.recovery.status).toBe('running');
  });

  it('can complete execution with a failed investigation result', () => {
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'fixture/execution', runId: 'failed', now: () => '2026-09-08T00:00:00.000Z' });
    expect(investigationExecutionSummary({ run: checkpoint.run, recovery: { ...checkpoint.recovery, status: 'completed' } })).toMatchObject({
      state: 'completed', result: 'failed',
    });
  });
});
