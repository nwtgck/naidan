import { describe, expect, it } from 'vitest';
import { investigationFeatureResults } from './investigation-feature-results';
import { createInitialInvestigationCheckpoint } from './investigation-recovery';
import { configurationForPreset, resolveInvestigationExecutionPlan } from './investigation-config';
import { createProductionProviderTrace } from './production-provider-trace';
import { captureScenarioInput } from './production-provider-capture-plan';
import { evaluateEvidenceReadiness } from './evaluate-evidence-readiness';

describe('recorded feature results versus collection completion', () => {
  it('presents a fulfilled Provider request as observed without inventing missing legacy Production or Reference work', () => {
    const { run } = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'provider-run', now: () => '2026-09-10T00:00:00.000Z' });
    const requestId = 'provider-run-first-turn';
    const trace = createProductionProviderTrace({ requestId, limits: { maximumEvents: 16, maximumCharacters: 1024 } });
    trace.settle({ outcome: 'fulfilled', error: undefined });
    run.productionProviderCapture = {
      format: 'production-provider-capture-v2', runId: run.runId, modelId: run.modelId, plan: 'first-only', run: { status: 'completed' },
      lifetime: 'open', abortReason: undefined, disposal: 'not-requested', observation: 'open', events: [],
      requests: [{ runId: run.runId, requestId, scenario: 'first-turn', status: 'settled', notStartedReason: undefined, input: captureScenarioInput({ scenario: 'first-turn', firstSettled: undefined }), trace: trace.snapshot() }],
      capabilities: { providerCallbacks: 'bounded-projection', nativeInvocations: 'not-collected-by-this-owner', tools: 'not-selected', images: 'not-selected' },
    };
    const result = investigationFeatureResults({ run });
    expect(result.results.find(item => item.id === `provider-${requestId}`)).toMatchObject({ outcome: 'observed', needsAttention: false });
    expect(result.results.some(item => item.id === 'production-first-turn')).toBe(false);
    expect(result.results.find(item => item.id === 'reference-not-selected')).toMatchObject({ outcome: 'not-selected', needsAttention: false });
    expect(result.failed).toBe(0);
    expect(result.notRun).toBe(0);
    const routing = evaluateEvidenceReadiness({ run }).domains.find(domain => domain.domainId === 'production-routing');
    expect(routing?.summary).toContain('Public Provider requests were recorded');
    expect(routing?.status).not.toBe('implementation-ready');
  });

  it('retains nested failure and reason when the outer collection passed', () => {
    const { run } = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'failed-first-turn', now: () => '2026-09-09T00:00:00.000Z' });
    run.status = 'passed';
    run.productionLane = { status: 'passed', observation: undefined, error: undefined, partialObservation: {
      modelId: run.modelId, resolvedRevision: 'a'.repeat(40), candidate: undefined, route: undefined, isEncoderDecoder: undefined,
      firstTurn: { status: 'failed', error: { name: 'FirstTurnError', message: 'generation failed' } },
      continuity: { status: 'not-run', reason: 'First turn failed' },
      toolResultContinuation: undefined, reasoning: undefined, multimodal: undefined,
    } };
    const result = investigationFeatureResults({ run });
    expect(result.failed).toBe(1);
    expect(result.notRun).toBe(1);
    expect(result.results[0]).toMatchObject({ id: 'production-first-turn', outcome: 'failed', detail: 'FirstTurnError: generation failed' });
    expect(result.results[1]).toMatchObject({ id: 'production-continuity', outcome: 'not-run', detail: 'First turn failed' });
    expect(run.status).toBe('passed');
  });

  it('reports missing-cache blockers with reasons instead of inferring load success from collection', () => {
    const { run } = createInitialInvestigationCheckpoint({ modelId: 'org/missing', runId: 'missing-cache', now: () => '2026-09-09T00:00:00.000Z' });
    run.status = 'passed';
    run.executionPlan = resolveInvestigationExecutionPlan({ scope: configurationForPreset({ preset: 'full' }).scope });
    run.steps = [{ id: 'loading-investigation', status: 'blocked', detail: 'No locally cached model artifacts' }];
    const result = investigationFeatureResults({ run });
    expect(result.results[0]).toMatchObject({ id: 'stage-loading-investigation', outcome: 'blocked', detail: 'No locally cached model artifacts' });
    expect(result.notRun).toBe(1);
    expect(result.results.find(item => item.id === 'production-first-turn')?.outcome).toBe('not-recorded');
    expect(result.results.some(item => item.outcome === 'passed')).toBe(false);
  });

  it('does not count unselected scopes as unexecuted warnings', () => {
    const { run } = createInitialInvestigationCheckpoint({ modelId: 'org/metadata', runId: 'unselected', now: () => '2026-09-09T00:00:00.000Z' });
    run.requestedConfiguration = configurationForPreset({ preset: 'download-focused' });
    const result = investigationFeatureResults({ run });
    expect(result.results.every(item => item.outcome === 'not-selected')).toBe(true);
    expect(result.notRun).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('keeps missing legacy evidence unknown rather than inventing success or unselected scope', () => {
    const { run } = createInitialInvestigationCheckpoint({ modelId: 'org/legacy', runId: 'legacy', now: () => '2026-09-09T00:00:00.000Z' });
    const result = investigationFeatureResults({ run });
    expect(result.results.every(item => item.outcome === 'not-recorded')).toBe(true);
    expect(result.failed).toBe(0);
    expect(result.notRun).toBe(0);
  });
});
