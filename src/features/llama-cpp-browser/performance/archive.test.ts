// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { performanceEnvironment, performancePlan, performanceReport } from '@/features/llama-cpp-browser/test-utils/performance.test-support';
import { performanceArchive } from './archive';
import { summarizePerformance, performanceFindings, trialRates } from './summary';
import { runtimeBuildEvidence } from './runtime-evidence';
import { diagnosticSchema } from '@/features/llama-cpp-browser/debug-log';
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
  it('keeps optional kernel diagnostics separate from model trials and throughput summaries', async () => {
    const source = snapshot();
    const summary = summarizePerformance({ snapshot: source });
    source.q8KernelDiagnostic = { status: 'unavailable', startedMs: 500, elapsedMs: 1, hiddenObserved: false, result: { status: 'unavailable', reason: 'artifact' } };
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
    expect(JSON.parse(await zip.file('q8-kernel-diagnostic.json')!.async('string'))).toEqual(source.q8KernelDiagnostic);
    expect(JSON.parse(await zip.file('summary.json')!.async('string'))).toEqual(JSON.parse(JSON.stringify(summary)));
    expect(await zip.file('trials.jsonl')!.async('string')).not.toContain('q8KernelDiagnostic');
    const readme = await zip.file('README.md')!.async('string');
    expect(readme).toContain('self-authored Q8 weights');
    expect(readme).toContain(`\
neither
ordinary chat tok/s`);
    expect(readme).toContain('timingStatus=quantized');
  });

  it('writes an actual readable ZIP, keeping messages in per-attempt outputs rather than metrics', async () => {
    const source = snapshot();
    const archive = await performanceArchive({ snapshot: source });
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    const records = await zip.file('trials.jsonl')!.async('string');
    expect(JSON.parse(records).input).toBeUndefined();
    expect(records).not.toContain('answer');
    expect(JSON.parse(await zip.file('outputs/attempt_one.json')!.async('string')).output.content).toBe('answer');
    const exportedPlan = JSON.parse(await zip.file('plan.json')!.async('string'));
    expect(exportedPlan.id).toBe(source.plan.id);
    expect(exportedPlan.models).toEqual([{ modelId: 'user/m0', size: 4096, importedAt: 1 }]);
    expect(JSON.parse(await zip.file('environment.json')!.async('string')).timeOrigin).toBe(1000);
    expect(Object.keys(zip.files).some(name => name.endsWith('.gguf'))).toBe(false);
    expect(source.trials[0]?.output?.content).toBe('answer');
    expect(zip.file('q8-kernel-diagnostic.json')).toBeNull();
  });

  it('preserves the request-local cache decision and checkpoint phases in the existing trials export', async () => {
    const source = snapshot();
    const metrics = source.trials[0]!.summary!.performance!;
    metrics.cacheReuse = {
      tokens: 80,
      cachedTokens: 60,
      commonPrefixTokens: 24,
      reusedTokens: 20,
      evaluatedTokens: 60,
      cacheComparison: 'token-mismatch',
      reason: 'checkpoint-match',
      nativeMemoryKind: 'hybrid',
      nativePositionMin: 0,
      nativePositionMax: 59,
      nativeRollbackTokens: 0,
      cacheRemoval: 'full-only',
      checkpointTokens: 20,
      checkpointBytes: 4096,
    };
    metrics.checkpoint = {
      captureAttempts: 0,
      restoreAttempts: 1,
      retainedRestoredCaptures: 1,
      phases: [{ phase: 'restore-write', visits: 1, elapsedMs: 123 }],
    };
    metrics.earlyGenerationTiming = {
      version: 1,
      limit: 16,
      stageIntervals: [{ stage: 'generation-overlap', ordinal: 1, sampleCountAtStart: 1, startMs: 100, elapsedMs: 1512, closedBy: 'stage-transition' }],
      samples: [{ ordinal: 1, atMs: 99 }, { ordinal: 2, atMs: 1613 }],
      intervalsTruncated: false,
      samplesTruncated: false,
      clockAnomalies: 0,
    };
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
    const record = JSON.parse(await zip.file('trials.jsonl')!.async('string'));
    const exported = diagnosticSchema.parse(record.summary).performance!;
    expect(exported.cacheReuse).toEqual(metrics.cacheReuse);
    expect(exported.checkpoint).toEqual(metrics.checkpoint);
    expect(exported.earlyGenerationTiming).toEqual(metrics.earlyGenerationTiming);
    expect(await zip.file('README.md')!.async('string')).toContain('cacheReuse records the cache decision before prefill');
    expect(await zip.file('README.md')!.async('string')).toContain('generation-overlap includes delivery and decode');
  });

  it.each(['clean', 'dirty', 'unknown'] as const)('preserves the run app identity with a %s working tree at export', async workingTree => {
    const source = snapshot();
    source.environment.appSource = { sourceCommit: 'a'.repeat(40), workingTree };
    vi.stubGlobal('__APP_SOURCE__', { sourceCommit: 'b'.repeat(40), workingTree: 'clean' });
    using _cleanupResource = {
      [Symbol.dispose]() {
        vi.unstubAllGlobals();
      },
    };
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
    const environment = JSON.parse(await zip.file('environment.json')!.async('string'));
    expect(environment.appVersion).toBe('test');
    expect(environment.appSource).toEqual(source.environment.appSource);
  });

  it('exports unavailable app revision explicitly without manufacturing a clean checkout', async () => {
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: snapshot() })).arrayBuffer());
    expect(JSON.parse(await zip.file('environment.json')!.async('string')).appSource).toEqual({ workingTree: 'unknown' });
    const readme = await zip.file('README.md')!.async('string');
    expect(readme).toContain('sourceCommit means the revision was unavailable');
    expect(readme).toContain('Development hot updates and changes after config loading are not captured');
    expect(readme).not.toContain('Record the Naidan commit');
  });

  it('rejects malformed app source revisions at the archive boundary', async () => {
    const source = snapshot();
    source.environment.appSource.sourceCommit = 'not-a-revision';
    await expect(performanceArchive({ snapshot: source })).rejects.toThrow();
  });

  it('exports all-failed plans and missing values without inventing numeric zero', async () => {
    const source = snapshot();
source.trials[0]!.status = 'failed';
source.trials[0]!.summary = undefined;
    source.trials[0]!.exclusion = ['failed', 'missing-summary'];
    source.modelErrors.push({ modelIndex: 0, error: 'test failure' });
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
    expect(JSON.parse(await zip.file('summary.json')!.async('string'))).toEqual([]);
    expect(await zip.file('summary.csv')!.async('string')).toContain('"failed;missing-summary","300","","","","",""');
    expect(JSON.parse(await zip.file('manifest.json')!.async('string')).modelErrors).toEqual(source.modelErrors);
  });

  it('quotes formula-like metadata and rejects path-like run identifiers', async () => {
    const source = snapshot();
source.trials[0]!.error = '=1+1';
const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
expect(await zip.file('summary.csv')!.async('string')).toContain('"\'=1+1"');
    source.trials[0]!.id = '../invalid';
    await expect(performanceArchive({ snapshot: source })).rejects.toThrow();
  });

  it('does not export a mutating run', async () => {
    const source = snapshot();
    source.status = 'running';
    await expect(performanceArchive({ snapshot: source })).rejects.toThrow('Stop measurement');
  });

  it('uses non-EOG intervals, not event/decode counts; one token and zero duration stay missing', () => {
    const source = snapshot();
    const trial = source.trials[0]!;
    expect(trialRates({ trial }).generationTokensPerSecond).toBe(10);
    trial.summary!.performance!.nonEogTokens = 1;
    expect(trialRates({ trial }).generationTokensPerSecond).toBeUndefined();
    trial.summary!.performance!.nonEogTokens = 2;
trial.summary!.performance!.lastNonEogSampleMs = 100;
expect(trialRates({ trial }).generationTokensPerSecond).toBeUndefined();
  });

  it('separates allocation fallback conditions instead of averaging them together', () => {
    const source = snapshot();
    const first = source.trials[0]!;
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
  expect(readme).toContain('NOT collected');
  expect(readme).toContain('not GPU kernel time');
  expect(zip.file('findings.json')).not.toBeNull();
  expect(zip.file('backend-placement.json')).not.toBeNull();
});

it('keeps chronological drift distinct from output changes, missing data, and excluded attempts', () => {
  const source = snapshot();
  const base = source.trials[0]!;
  const before = source.plan.steps.find(step => step.position === 'before')!;
  const after = source.plan.steps.find(step => step.position === 'after')!;
  source.trials = [before, after].map((step, index) => ({ ...base, id: `attempt_${index}`, stepId: step.id, summary: performanceReport() }));
  for (const trial of source.trials) {
trial.summary!.performance!.preparationEvents = [{ event: 'model-reused', observedMs: 0 }];
  }
  source.trials[1]!.summary!.performance!.lastNonEogSampleMs = 300;
  expect(performanceFindings({ snapshot: source })).toMatchObject([{ reasons: [], afterToBeforeRatio: 0.5 }]);
  source.trials[1]!.exclusion = ['page-hidden'];
  expect(performanceFindings({ snapshot: source })[0]!.afterToBeforeRatio).toBeUndefined();
  source.trials[1]!.exclusion = [];
source.trials[1]!.output = { ...base.output!, content: 'different' };
expect(performanceFindings({ snapshot: source })[0]!.reasons).toContain('different-generated-output');
source.trials.pop();
expect(performanceFindings({ snapshot: source })[0]!.reasons).toContain('missing-attempt');
});

it('exports partial memory evidence with model attribution even without a terminal summary', async () => {
  const source = snapshot(), trial = source.trials[0]!;
  trial.status = 'failed';
  trial.summary = undefined;
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
  const source = snapshot();
source.trials[0]!.id = id;
const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
expect(JSON.parse((await zip.file('trials.jsonl')!.async('string')).trim()).id).toBe(id);
expect(zip.file(`outputs/${id}.json`)).not.toBeNull();
expect((await zip.file('summary.csv')!.async('string')).split('\r\n')[1]!.startsWith(`"${csvId}",`)).toBe(true);
expect(await zip.file('README.md')!.async('string')).toContain('only when the resulting ID matches trials.jsonl');
});

it('keeps flash request/resolution and retry boundaries in the existing failed-attempt history', async () => {
  const source = snapshot();
  const trial = source.trials[0]!;
  trial.status = 'failed';
  trial.memoryDiagnostics = {
    samples: [],
    droppedSamples: 0,
    nativeAllocations: [],
    droppedNativeAllocations: 0,
    nativeSettings: [
      { observedMs: 1, contextAttempt: 1, contextEvent: 'context-start' },
      { observedMs: 2, contextAttempt: 1, nativeFlashAttention: { kind: 'requested', mode: 'auto' } },
      { observedMs: 3, contextAttempt: 1, nativeFlashAttention: { kind: 'resolved', mode: 'enabled' } },
      { observedMs: 4, contextAttempt: 2, contextEvent: 'context-retry' },
      { observedMs: 5, nativeMetric: 'n_ctx', nativeValue: 4096 },
    ],
    droppedNativeSettings: 2,
  };
  const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
  const record = JSON.parse((await zip.file('trials.jsonl')!.async('string')).trim());
  const observations = JSON.parse(await zip.file(record.memoryDiagnosticsFile)!.async('string'));
  expect(observations.nativeSettings).toEqual(trial.memoryDiagnostics.nativeSettings);
  expect(record.memoryDiagnosticsCoverage.nativeSettings).toBe(5);
  expect(record.memoryDiagnosticsCoverage.droppedNativeSettings).toBe(2);
  expect(observations.status).toBe('failed');
  expect(await zip.file('README.md')!.async('string')).toContain('Requested mode alone is never resolved selection');
});

it('exports a loaded descriptor with lossless counts after cancellation without a terminal summary', async () => {
  const source = snapshot();
  const trial = source.trials[0]!;
  trial.status = 'cancelled';
  trial.summary = undefined;
  trial.memoryDiagnostics = { samples: [], droppedSamples: 0, nativeAllocations: [], droppedNativeAllocations: 0, nativeSettings: [{ observedMs: 1, loadedModelDescriptor: { source: 'loaded-model-native-api', architecture: 'qwen35', fileType: 15, parameterCount: '9007199254740993', tensorBytes: '18446744073709551615' } }], droppedNativeSettings: 0 };
  const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
  const record = JSON.parse((await zip.file('trials.jsonl')!.async('string')).trim());
  const observations = JSON.parse(await zip.file(record.memoryDiagnosticsFile)!.async('string'));
  expect(observations.nativeSettings).toEqual(trial.memoryDiagnostics.nativeSettings);
  expect(observations.status).toBe('cancelled');
  expect(await zip.file('README.md')!.async('string')).toContain('source=loaded-model-native-api');
});

it('keeps app and runtime identity beside native model and Flash Attention observations in one archive', async () => {
  const source = snapshot();
  const trial = source.trials[0]!;
  source.environment.appSource = { sourceCommit: 'a'.repeat(40), workingTree: 'dirty' };
  source.environment.runtimeBuild = {
    sourceCommit: 'b'.repeat(40),
    files: [{ path: 'llama-cpp-browser-core/profiles/cpu-wasm32/browser/core.wasm', bytes: 123, sha256: 'c'.repeat(64) }],
  };
  trial.memoryDiagnostics = {
    samples: [],
    droppedSamples: 0,
    nativeAllocations: [],
    droppedNativeAllocations: 0,
    nativeSettings: [
      { observedMs: 1, loadedModelDescriptor: { source: 'loaded-model-native-api', architecture: 'qwen35', parameterCount: '9007199254740993' } },
      { observedMs: 2, contextAttempt: 1, contextEvent: 'context-start' },
      { observedMs: 3, contextAttempt: 1, nativeFlashAttention: { kind: 'requested', mode: 'auto' } },
      { observedMs: 4, contextAttempt: 1, nativeFlashAttention: { kind: 'resolved', mode: 'enabled' } },
      { observedMs: 5, contextAttempt: 1, contextEvent: 'context-ready' },
    ],
    droppedNativeSettings: 0,
  };
  const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
  const environment = JSON.parse(await zip.file('environment.json')!.async('string'));
  expect(environment.appSource).toEqual(source.environment.appSource);
  expect(environment.runtimeBuild).toEqual(source.environment.runtimeBuild);
  const record = JSON.parse((await zip.file('trials.jsonl')!.async('string')).trim());
  const observations = JSON.parse(await zip.file(record.memoryDiagnosticsFile)!.async('string'));
  expect(observations.nativeSettings).toEqual(trial.memoryDiagnostics.nativeSettings);
  expect(record.memoryDiagnosticsCoverage.nativeSettings).toBe(5);
  const readme = await zip.file('README.md')!.async('string');
  expect(readme).toContain('source-checkout evidence, not a hash of built or executing app bytes');
  expect(readme).toContain('source=loaded-model-native-api');
  expect(readme).toContain('Requested mode alone is never resolved selection');
});

it('round-trips optional diagnostic completion groups and their interpretation without putting them in speed summaries', async () => {
  const source = snapshot();
  source.plan = performancePlan({ diagnostics: 'placement' });
  source.trials[0]!.stepId = source.plan.steps.find(step => step.scenario === 'placement')!.id;
  source.trials[0]!.exclusion = ['instrumented'];
  const census = {
    version: 1 as const,
    method: 'native-eval-metadata' as const,
    timing: 'not-a-speed-measurement' as const,
    placementMeaning: 'destination-buffer-not-execution-backend' as const,
    observedNodes: 1,
    droppedNodes: 0,
    errors: 0,
    decodeCompletionTiming: {
      method: 'per-node-synchronized-wall-time' as const,
      requestedNodes: 1,
      completedNodes: 1,
      timedNodes: 1,
      unattributedNodes: 0,
      unfinishedNodes: 0,
      skippedNodes: 0,
      errors: 0,
      totalMs: 9,
    },
    entries: [{
      phase: 'decode' as const,
      description: 'MUL_MAT_ID',
      compute: true,
      op: 'GGML_OP_MUL_MAT_ID',
      type: 'GGML_TYPE_F32',
      shape: [2560, 10, 1, 1],
      inputs: [{ type: 'GGML_TYPE_Q5_1', shape: [640, 2560, 512, 1] }],
      buffer: 'WebGPU',
      storage: 'device' as const,
      webgpuSupport: 'supported' as const,
      metadataOnly: false,
      nodes: 1,
      examples: ['ffn_moe_down-43'],
      completionTiming: { samples: 1, totalMs: 9, minMs: 9, maxMs: 9, maxNodeName: 'ffn_moe_down-43', maxNodeIndex: 1 },
    }],
  };
  source.trials[0]!.summary!.performance!.backendCensus = census;
  const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
  expect(JSON.parse(await zip.file('backend-placement.json')!.async('string'))[0].diagnostic).toEqual(census);
  expect(JSON.parse(await zip.file('summary.json')!.async('string'))).toEqual([]);
  const readme = await zip.file('README.md')!.async('string');
  expect(readme).toContain('not GPU kernel time');
  expect(readme).toContain('including views');
  expect(readme).toContain('unfinishedNodes');
  expect(readme).toContain('maxNodeIndex');
  expect(readme).toContain('split-input copies');
  expect(readme).toContain('orthogonal to the selected standard/GPU-profiling lane');
});

describe('interrupted observations in the actual ZIP', () => {
  it.each(['new-scope', 'not-needed', 'stopped', 'failed'] as const)('retains outputs, partial GPU timing, memory and recovery=%s', async recovery => {
    const source = snapshot(), trial = source.trials[0]!;
    trial.status = 'interrupted';
    trial.runtimeSegment = 0;
    trial.interruption = { reason: 'user-skip', requestedMs: 200, settledMs: 300, recovery };
    trial.output = undefined;
    trial.partialText = 'partial answer';
    trial.partialReasoning = 'partial reasoning';
    trial.exclusion = ['interrupted', 'instrumented', 'incomplete-output', 'incomplete-summary'];
    trial.options = { ...trial.options, profile: 'webgpu-wasm64-jspi-gpu-profile' };
    trial.summary = performanceReport({ outcome: 'aborted' });
    trial.summary.performance!.gpuProfile = {
      version: 1,
      source: 'webgpu-pass-timestamps',
      status: 'partial',
      observedPasses: 2,
      measuredPasses: 1,
      pendingPasses: 1,
      invalidPasses: 0,
      droppedPasses: 0,
      ungroupedPasses: 0,
      ambiguousPasses: 0,
      instrumentationErrors: 0,
      zeroDurationPasses: 0,
      totalGpuMs: 12.5,
      precision: 'browser-defined',
      rows: [{
        phase: 'decode',
        shader: 'fixture_q4_K',
        passes: 1,
        dispatches: 1,
        multiDispatchPasses: 0,
        totalGpuMs: 12.5,
        meanPassMs: 12.5,
        minimumPassMs: 12.5,
        maximumPassMs: 12.5,
        zeroDurationPasses: 0,
      }],
    };
    trial.memoryDiagnostics = {
      samples: [{ kind: 'naidan-llama-cpp-memory', instanceId: 'interrupted-core', profile: 'webgpu-wasm64-jspi-gpu-profile', checkpoint: 'generation-interrupted', capacityBytes: 65536, timestamp: 190 }],
      droppedSamples: 1,
      nativeAllocations: [],
      droppedNativeAllocations: 0,
      nativeSettings: [],
      droppedNativeSettings: 0,
    };
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
    const record = JSON.parse(await zip.file('trials.jsonl')!.async('string'));
    expect(record).toMatchObject({ status: 'interrupted', interruption: trial.interruption, runtimeSegment: 0, gpuProfileCoverage: { status: 'partial', pendingPasses: 1 } });
    expect(record.summary.performance.gpuProfile).toBeUndefined();
    const output = JSON.parse(await zip.file(`outputs/${trial.id}.json`)!.async('string'));
    expect(output).toMatchObject({ status: 'interrupted', interruption: trial.interruption, partialText: 'partial answer', partialReasoning: 'partial reasoning' });
    expect(output.output).toBeUndefined();
    expect(JSON.parse(await zip.file(`memory/${trial.id}.json`)!.async('string'))).toMatchObject({ status: 'interrupted', interruption: trial.interruption, ...trial.memoryDiagnostics });
    expect(JSON.parse(await zip.file('gpu-profile.jsonl')!.async('string'))).toMatchObject({ status: 'interrupted', interruption: trial.interruption, observation: { totalGpuMs: 12.5, status: 'partial' } });
    expect(JSON.parse(await zip.file('gpu-profile-summary.json')!.async('string'))).toMatchObject([{ status: 'interrupted', interruption: trial.interruption, runtimeSegment: 0, observationStatus: 'partial' }]);
    expect(JSON.parse(await zip.file('summary.json')!.async('string'))).toEqual([]);
    const csv = await zip.file('summary.csv')!.async('string');
    expect(csv).toContain('"interrupt_requested_ms"');
    expect(csv).toContain(`"0","200","300","${recovery}",""`);
    expect(await zip.file('README.md')!.async('string')).toContain('Unsaved Worker-local data cannot be recovered');
  });

  it('keeps missing summaries unavailable after forced termination instead of inventing a zero GPU time', async () => {
    const source = snapshot(), trial = source.trials[0]!;
    trial.status = 'interrupted';
    trial.interruption = { reason: 'user-skip', requestedMs: 10, settledMs: 5010, recovery: 'new-scope' };
    trial.options = { ...trial.options, profile: 'webgpu-wasm64-jspi-gpu-profile' };
    trial.summary = undefined;
    trial.output = undefined;
    trial.exclusion = ['interrupted', 'missing-summary', 'incomplete-output', 'instrumented'];
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
    const gpu = JSON.parse(await zip.file('gpu-profile.jsonl')!.async('string'));
    expect(gpu.observationStatus).toBe('missing');
    expect(gpu.observation).toBeUndefined();
    expect(gpu.status).toBe('interrupted');
    expect(JSON.parse(await zip.file('outputs/attempt_one.json')!.async('string')).partialText).toBe('answer');
  });
});
