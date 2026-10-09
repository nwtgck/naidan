// @vitest-environment node
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { performanceEnvironment, performancePlan, performanceReport } from '@/features/llama-cpp-browser/test-utils/performance';
import { performanceArchive } from './archive';
import { summarizePerformance, performanceFindings, trialRates } from './summary';
import { runtimeBuildEvidence } from './runtime-evidence';
import type { PerformanceSnapshot } from './types';

function snapshot(): PerformanceSnapshot {
  const plan = performancePlan();
  return {
    plan,
    environment: performanceEnvironment(),
    status: 'completed',
    modelErrors: [],
    trials: [{
      id: 'attempt_one',
      stepId: plan.steps[0]!.id,
      modelIndex: 0,
      status: 'succeeded',
      startedAt: plan.createdAt,
      input: [{ role: 'user', content: 'fixture' }],
      options: plan.options,
      partialText: 'answer',
      partialReasoning: '',
      output: { content: 'answer', reasoningContent: '', toolCalls: [], finishReason: 'stop' },
      elapsedMs: 300,
      receivedEvents: 1,
      hiddenObserved: false,
      summary: performanceReport(),
      warnings: [],
      exclusion: [],
    }],
  };
}

describe('portable performance results', () => {
  it('writes an actual readable ZIP, keeping messages in per-attempt outputs rather than metrics', async () => {
    const source = snapshot(); const archive = await performanceArchive({ snapshot: source });
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    const records = await zip.file('trials.jsonl')!.async('string');
    expect(JSON.parse(records).input).toBeUndefined();
    expect(records).not.toContain('answer');
    expect(JSON.parse(await zip.file('outputs/attempt_one.json')!.async('string')).output.content).toBe('answer');
    expect(JSON.parse(await zip.file('plan.json')!.async('string')).id).toBe(source.plan.id);
    expect(JSON.parse(await zip.file('environment.json')!.async('string')).timeOrigin).toBe(1000);
    expect(Object.keys(zip.files).some(name => name.endsWith('.gguf'))).toBe(false);
    expect(source.trials[0]?.output?.content).toBe('answer');
  });

  it('exports all-failed plans and missing values without inventing numeric zero', async () => {
    const source = snapshot(); source.trials[0]!.status = 'failed'; source.trials[0]!.summary = undefined;
    source.trials[0]!.exclusion = ['failed', 'missing-summary']; source.modelErrors.push({ modelIndex: 0, error: 'test failure' });
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
    expect(JSON.parse(await zip.file('summary.json')!.async('string'))).toEqual([]);
    expect(await zip.file('summary.csv')!.async('string')).toContain('"failed;missing-summary","300","","","","",""');
    expect(JSON.parse(await zip.file('manifest.json')!.async('string')).modelErrors).toEqual(source.modelErrors);
  });

  it('quotes formula-like metadata and rejects path-like run identifiers', async () => {
    const source = snapshot(); source.plan.models[0]!.name = '=1+1';
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
    expect(await zip.file('summary.csv')!.async('string')).toContain('"\'=1+1"');
    source.trials[0]!.id = '../invalid'; await expect(performanceArchive({ snapshot: source })).rejects.toThrow();
  });

  it('does not export a mutating run', async () => {
    const source = snapshot(); source.status = 'running';
    await expect(performanceArchive({ snapshot: source })).rejects.toThrow('Stop measurement');
  });

  it('uses non-EOG intervals, not event/decode counts; one token and zero duration stay missing', () => {
    const source = snapshot(); const trial = source.trials[0]!;
    expect(trialRates({ trial }).generationTokensPerSecond).toBe(10);
    trial.summary!.performance!.nonEogTokens = 1;
    expect(trialRates({ trial }).generationTokensPerSecond).toBeUndefined();
    trial.summary!.performance!.nonEogTokens = 2; trial.summary!.performance!.lastNonEogSampleMs = 100;
    expect(trialRates({ trial }).generationTokensPerSecond).toBeUndefined();
  });

  it('separates allocation fallback conditions instead of averaging them together', () => {
    const source = snapshot(); const first = source.trials[0]!;
    source.trials.push({ ...first, id: 'attempt_two', summary: performanceReport() });
    source.trials[1]!.summary!.performance!.contextTokens = 2048;
    expect(summarizePerformance({ snapshot: source })).toHaveLength(2);
  });

  it('keeps truncated-parent measurements useful but separate from completed-parent continuations', async () => {
    const source = snapshot();
    source.plan = performancePlan({ repeats: 2 });
    const base = source.trials[0]!;
    source.trials = source.plan.steps.filter(step => step.scenario === 'short' && step.position === 'before' || step.scenario === 'continuation').map((step, index) => ({
      ...base,
      id: `attempt_${index}`,
      stepId: step.id,
      output: { ...base.output!, finishReason: index === 2 ? 'length' : 'stop' },
      warnings: index === 3 ? ['incomplete-parent'] : [],
      // Parent measurements stay valid; restrict this assertion to continuations.
    }));
    expect(summarizePerformance({ snapshot: source }).filter(group => group.scenario === 'continuation')).toMatchObject([
      { scenario: 'continuation', parentFinishReason: 'stop', count: 1 },
      { scenario: 'continuation', parentFinishReason: 'length', count: 1 },
    ]);
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
    expect(await zip.file('summary.csv')!.async('string')).toContain('incomplete-parent');
    expect(JSON.parse(await zip.file('summary.json')!.async('string'))).toHaveLength(4);
  });

  it('records only the llama published-artifact identity and treats incompatible manifests as unknown', () => {
    const sha256 = 'a'.repeat(64), sourceCommit = 'b'.repeat(40);
    const llama = { path: 'llama-cpp-browser-core/profiles/cpu-wasm32/browser/core.wasm', bytes: 123, sha256 };
    expect(runtimeBuildEvidence({ manifest: { formatVersion: 3, sourceCommit, files: [llama, { ...llama, path: 'stable-diffusion-cpp-browser-core/core.wasm' }] } })).toEqual({ sourceCommit, files: [llama] });
    expect(runtimeBuildEvidence({ manifest: { formatVersion: 1 } })).toBeUndefined();
  });
});

it('writes an English README and explicitly describes observations that were not collected', async () => {
  const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: snapshot() })).arrayBuffer());
  expect(zip.file('README-ja.md')).toBeNull();
  const readme = await zip.file('README.md')!.async('string');
  expect(Array.from(readme).every(char => char.charCodeAt(0) < 128)).toBe(true);
  expect(readme).toContain('NOT collected'); expect(readme).toContain('not GPU kernel time');
  expect(zip.file('findings.json')).not.toBeNull(); expect(zip.file('backend-placement.json')).not.toBeNull();
});

it('keeps chronological drift distinct from output changes, missing data, and excluded attempts', () => {
  const source = snapshot(); const base = source.trials[0]!;
  const before = source.plan.steps.find(step => step.position === 'before')!;
  const after = source.plan.steps.find(step => step.position === 'after')!;
  source.trials = [before, after].map((step, index) => ({ ...base, id: `attempt_${index}`, stepId: step.id, summary: performanceReport() }));
  for (const trial of source.trials) trial.summary!.performance!.preparationEvents = [{ event: 'model-reused', observedMs: 0 }];
  source.trials[1]!.summary!.performance!.lastNonEogSampleMs = 300;
  expect(performanceFindings({ snapshot: source })).toMatchObject([{ reasons: [], afterToBeforeRatio: 0.5 }]);
  source.trials[1]!.exclusion = ['page-hidden'];
  expect(performanceFindings({ snapshot: source })[0]!.afterToBeforeRatio).toBeUndefined();
  source.trials[1]!.exclusion = []; source.trials[1]!.output = { ...base.output!, content: 'different' };
  expect(performanceFindings({ snapshot: source })[0]!.reasons).toContain('different-generated-output');
  source.trials.pop(); expect(performanceFindings({ snapshot: source })[0]!.reasons).toContain('missing-attempt');
});

it('exports partial memory evidence with model attribution even without a terminal summary', async () => {
  const source = snapshot(), trial = source.trials[0]!;
  trial.status = 'failed'; trial.summary = undefined;
  trial.memoryDiagnostics = {
    samples: [{ kind: 'naidan-llama-cpp-memory', instanceId: 'core-one', profile: 'cpu-wasm32', checkpoint: 'model-load-failed', capacityBytes: 65536, timestamp: 10 }],
    droppedSamples: 2,
    nativeAllocations: [{ observedMs: 4, nativeMetric: 'recurrent_buffer_mib', nativeBackend: 'CPU', nativeValue: 8.25 }],
    droppedNativeAllocations: 0,
    nativeSettings: [],
    droppedNativeSettings: 0,
  };
  const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
  const record = JSON.parse((await zip.file('trials.jsonl')!.async('string')).trim());
  expect(record.memoryDiagnosticsFile).toBe(`memory/${trial.id}.json`);
  const observations = JSON.parse(await zip.file(record.memoryDiagnosticsFile)!.async('string'));
  expect(observations).toEqual({ attemptId: trial.id, modelIndex: 0, status: 'failed', ...trial.memoryDiagnostics });
  expect(record.memoryDiagnostics).toBeUndefined();
  expect(record.memoryDiagnosticsCoverage).toEqual({ samples: 1, droppedSamples: 2, nativeAllocations: 1, droppedNativeAllocations: 0, nativeSettings: 0, droppedNativeSettings: 0 });
  expect(zip.file('memory-diagnostics.json')).toBeNull();
  expect(Object.keys(zip.files).filter(path => path.startsWith('memory/'))).toEqual([`memory/${trial.id}.json`]);
  expect(await zip.file('README.md')!.async('string')).toContain('Missing records/counters mean unavailable, not zero');
  expect(await zip.file('README.md')!.async('string')).toContain('not live GPU allocation');
});

it.each([
  ['-formula_safe', "'-formula_safe"],
  ['_ordinary_id', '_ordinary_id'],
  ['ordinary_id', 'ordinary_id'],
])('keeps JSON/file joins canonical when the CSV attempt ID is %s', async (id, csvId) => {
  const source = snapshot(); source.trials[0]!.id = id;
  const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
  expect(JSON.parse((await zip.file('trials.jsonl')!.async('string')).trim()).id).toBe(id);
  expect(zip.file(`outputs/${id}.json`)).not.toBeNull();
  expect((await zip.file('summary.csv')!.async('string')).split('\r\n')[1]!.startsWith(`"${csvId}",`)).toBe(true);
  expect(await zip.file('README.md')!.async('string')).toContain('only when the resulting ID matches trials.jsonl');
});
