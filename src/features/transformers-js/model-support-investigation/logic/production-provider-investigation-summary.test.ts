import { describe, expect, it } from 'vitest';
import { createProductionProviderCapturePolicy } from './production-provider-capture-policy';
import type { ProductionProviderInvestigationResult } from './run-production-provider-investigation';
import { createProductionProviderInvestigationSummaryEvidence, readProductionProviderInvestigationSummaryEvidence, validateProductionProviderInvestigationLiveProgress, type ProductionProviderInvestigationLiveProgress } from './production-provider-investigation-summary';

function summary(): ProductionProviderInvestigationResult['summary'] {
  return {
    format: 'production-provider-investigation-v1', policy: createProductionProviderCapturePolicy({ plan: 'first-only' }),
    completion: 'interrupted', stopReason: 'user-requested', providerEvidence: 'available',
    providerProgress: { runId: 'run-1', modelId: 'org/model', plan: 'first-only', run: { status: 'not-started' }, lifetime: 'closing', activeRequest: undefined, totalRequests: 1, selectedRequests: 1, settledRequests: 0, loadStatus: 'idle' },
    requests: [{ requestId: 'run-1-first-turn', scenario: 'first-turn', status: 'not-started', notStartedReason: 'not-yet-started', outcome: undefined, settledCompleteness: undefined, completeness: 'complete', limits: { maximumEvents: 1024, maximumCharacters: 65536, maximumFieldCharacters: 16384 }, retainedCharacters: 0, eventCount: 0 }],
    cutoff: { format: 'production-provider-native-cutoff-v1', runId: 'run-1', reason: 'user-requested', phaseAtCutoff: 'not-requested', maximumWorkerEpochs: 8, unrecordedWorkerCreations: 0, incompleteReasons: [], epochs: [] },
    nativeEvidenceStatus: 'available', cleanup: 'completed', sealOwnership: 'settled', progressCallbackFailures: 0,
  };
}

describe('Provider investigation summary evidence', () => {
  it('validates structured progress identity and freezes a copy without reading accessors', () => {
    const value: ProductionProviderInvestigationLiveProgress = { progress: { phase: 'not-started', provider: summary().providerProgress, stopReason: undefined, cleanup: 'not-requested', sealOwnership: 'settled' }, deadlines: { runMs: 1000, collectionMs: 100, sealingMs: 100, cleanupMs: 100 } };
    const parsed = validateProductionProviderInvestigationLiveProgress({ value, runId: 'run-1', modelId: 'org/model' });
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed.progress.provider)).toBe(true);
    expect(() => validateProductionProviderInvestigationLiveProgress({ value, runId: 'foreign', modelId: 'org/model' })).toThrow('Invalid Production Provider investigation progress');
    let read = false;
    Object.defineProperty(value, 'secret', { get() {
      read = true; throw new Error('Secret');
    } });
    expect(() => validateProductionProviderInvestigationLiveProgress({ value, runId: 'run-1', modelId: 'org/model' })).toThrow();
    expect(read).toBe(false);
  });

  it('rejects absent explicit unknowns and forged progress counters before UI adoption', () => {
    const value = { progress: { phase: 'running', provider: summary().providerProgress, stopReason: undefined, cleanup: 'not-requested', sealOwnership: 'settled' }, deadlines: { runMs: 1000, collectionMs: 100, sealingMs: 100, cleanupMs: 100 } };
    Reflect.deleteProperty(value.progress, 'stopReason');
    expect(() => validateProductionProviderInvestigationLiveProgress({ value, runId: 'run-1', modelId: 'org/model' })).toThrow();
    const forged = { ...value, progress: { ...value.progress, stopReason: undefined, provider: { ...value.progress.provider, selectedRequests: 2 } } };
    expect(() => validateProductionProviderInvestigationLiveProgress({ value: forged, runId: 'run-1', modelId: 'org/model' })).toThrow();
  });

  it('round-trips explicit undefined and does not claim native collection from a sealed unstarted index', () => {
    const original = summary();
    const evidence = createProductionProviderInvestigationSummaryEvidence({ summary: original, runId: 'run-1', modelId: 'org/model' });
    const decoded = readProductionProviderInvestigationSummaryEvidence({ ...evidence, runId: 'run-1', modelId: 'org/model' });
    expect(decoded).toEqual(original);
    expect(Object.hasOwn(decoded.requests[0]!, 'outcome')).toBe(true);
    expect(createProductionProviderInvestigationSummaryEvidence({ summary: decoded, runId: 'run-1', modelId: 'org/model' })).toEqual(evidence);
  });

  it('rejects missing undefined rather than inventing its observation', () => {
    const original = summary();
    Reflect.deleteProperty(original.requests[0]!, 'outcome');
    expect(() => createProductionProviderInvestigationSummaryEvidence({ summary: original, runId: 'run-1', modelId: 'org/model' })).toThrow('Invalid Production Provider investigation summary');
  });

  it('rejects unknown secret fields without invoking accessors', () => {
    const original = summary();
    let read = false;
    Object.defineProperty(original, 'secret', { get() {
      read = true; throw new Error('Private secret');
    } });
    expect(() => createProductionProviderInvestigationSummaryEvidence({ summary: original, runId: 'run-1', modelId: 'org/model' })).toThrow('Invalid Production Provider investigation summary');
    expect(read).toBe(false);
  });

  it('rejects foreign identities and inconsistent request counters', () => {
    const evidence = createProductionProviderInvestigationSummaryEvidence({ summary: summary(), runId: 'run-1', modelId: 'org/model' });
    expect(() => readProductionProviderInvestigationSummaryEvidence({ ...evidence, runId: 'foreign', modelId: 'org/model' })).toThrow();
    expect(() => readProductionProviderInvestigationSummaryEvidence({ ...evidence, runId: 'run-1', modelId: 'org/foreign' })).toThrow();
    const wrong = summary();
    const invalid = { ...wrong, providerProgress: { ...wrong.providerProgress, settledRequests: 1 } };
    expect(() => createProductionProviderInvestigationSummaryEvidence({ summary: invalid, runId: 'run-1', modelId: 'org/model' })).toThrow();
  });

  it('rejects forged undefined tags and extra envelope fields', () => {
    const evidence = createProductionProviderInvestigationSummaryEvidence({ summary: summary(), runId: 'run-1', modelId: 'org/model' });
    expect(() => readProductionProviderInvestigationSummaryEvidence({ json: evidence.json.replace('"captureValue": "undefined"', '"captureValue": "secret"'), runId: 'run-1', modelId: 'org/model' })).toThrow();
    expect(() => readProductionProviderInvestigationSummaryEvidence({ json: evidence.json.replace('"summary":', '"secret": "private", "summary":'), runId: 'run-1', modelId: 'org/model' })).toThrow();
  });

  it('rejects selected counters that disagree with the fixed plan', () => {
    const original = summary();
    const invalid = { ...original, providerProgress: { ...original.providerProgress, selectedRequests: 2 } };
    expect(() => createProductionProviderInvestigationSummaryEvidence({ summary: invalid, runId: 'run-1', modelId: 'org/model' })).toThrow();
  });

  it('rejects an awaiting request without its owned active identity', () => {
    const original = summary();
    const invalid: ProductionProviderInvestigationResult['summary'] = {
      ...original, providerProgress: { ...original.providerProgress, run: { status: 'running' } },
      requests: original.requests.map(request => ({ ...request, status: 'awaiting-settlement', notStartedReason: undefined })),
    };
    expect(() => createProductionProviderInvestigationSummaryEvidence({ summary: invalid, runId: 'run-1', modelId: 'org/model' })).toThrow();
  });
});
