// @vitest-environment node
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { performanceEnvironment, performancePlan, performanceReport } from '@/features/llama-cpp-browser/test-utils/performance.test-support';
import { gpuProfilingProfile } from '@/features/llama-cpp-browser/types';
import { createGpuProfileFixture, createMeasurementFixture } from '@/features/llama-cpp-browser/runtime/gpu-profiler.test-support';
import { performanceArchive } from './archive';
import { summarizePerformance } from './summary';
import { summarizeGpuProfiles } from './gpu-profile-summary';
import { gpuProfileSchema, maximumGpuProfileGroups } from './gpu-profile-schema';
import { planSchema, type PerformanceSnapshot } from './types';

function snapshot(): PerformanceSnapshot {
  const plan = performancePlan();
  return {
    plan,
    environment: performanceEnvironment(),
    status: 'completed',
    modelErrors: [],
    trials: [{
      id: 'gpu_attempt',
      stepId: plan.steps[0]!.id,
      modelIndex: 0,
      status: 'succeeded',
      startedAt: plan.createdAt,
      input: [{ role: 'user', content: 'fixture' }],
      options: { ...plan.options, profile: gpuProfilingProfile },
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

function profile() {
  using gpu = createGpuProfileFixture();
  using measurement = createMeasurementFixture();
  for (const { phase, shader, end } of [
    { phase: 'prefill', shader: 'mul_mat_q4_K', end: 9000000n },
    { phase: 'decode', shader: 'mul_mat_vec_q4_K', end: 3000000n },
    { phase: 'decode', shader: 'mul_mat_vec_q6_K', end: 7000000n },
  ] as const) {
    measurement.enter({ phase });
    const querySet = gpu.query({ values: [1000000n, end] });
    gpu.pass({ querySet, shader }).end();
    gpu.read({ querySet });
  }
  return measurement.finish();
}

describe('GPU profiling archive attribution and quality', () => {
  it('exports real timestamp observations with phase rankings, counts and raw records exactly once', async () => {
    const source = snapshot();
    source.trials[0]!.summary!.performance!.gpuProfile = profile();
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
    const raw = JSON.parse(await zip.file('gpu-profile.jsonl')!.async('string'));
    expect(raw.attemptId).toBe('gpu_attempt');
    expect(raw.observation.rows).toHaveLength(3);
    expect(raw.observation).toMatchObject({ status: 'complete', totalGpuMs: 16, measuredPasses: 3, pendingPasses: 0 });
    const summary = JSON.parse(await zip.file('gpu-profile-summary.json')!.async('string'));
    const decode = summary[0].phases.find((phase: { phase: string }) => phase.phase === 'decode');
    expect(decode.retainedGpuMs).toBe(8);
    expect(decode.rows.map((row: { shader: string }) => row.shader)).toEqual(['mul_mat_vec_q6_K', 'mul_mat_vec_q4_K']);
    expect(decode.rows[0]).toMatchObject({ dispatches: 1, meanPassMs: 6, amortizedDispatchMs: 6, shareOfRetainedPhaseGpuTime: 0.75 });
    const record = JSON.parse(await zip.file('trials.jsonl')!.async('string'));
    expect(JSON.stringify(record)).not.toContain('mul_mat_vec_q6_K');
    expect(record.summary.performance.gpuProfile).toBeUndefined();
    expect(record.gpuProfileFile).toBe('gpu-profile.jsonl');
    expect(record.gpuProfileCoverage.measuredPasses).toBe(3);
    expect(JSON.parse(await zip.file('summary.json')!.async('string'))).toEqual([]);
    // The missing exclusion flag cannot accidentally publish profiled throughput
    // as ordinary speed; requested runtime identity is a second boundary.
    expect(summarizePerformance({ snapshot: source })).toEqual([]);
    const csv = await zip.file('summary.csv')!.async('string');
    expect(csv).toContain('instrumented_generation_tokens_s');
    expect(source.trials[0]!.summary!.performance!.gpuProfile!.rows).toHaveLength(3);
  });

  it('does not fabricate zero timings when a profiled request failed before producing timestamps', async () => {
    const source = snapshot();
    source.trials[0]!.status = 'failed';
    source.trials[0]!.summary = undefined;
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot: source })).arrayBuffer());
    const raw = JSON.parse(await zip.file('gpu-profile.jsonl')!.async('string'));
    expect(raw.observationStatus).toBe('missing');
    expect(raw.observation).toBeUndefined();
    expect(JSON.parse(await zip.file('gpu-profile-summary.json')!.async('string'))[0].observationStatus).toBe('missing');
  });

  it('ranks only retained rows and preserves partial coverage rather than pretending all GPU time was attributed', () => {
    const source = snapshot();
    const result = profile();
    result.status = 'partial';
    result.ungroupedPasses = 1;
    result.totalGpuMs = 20;
    source.trials[0]!.summary!.performance!.gpuProfile = result;
    const summary = summarizeGpuProfiles({ snapshot: source })[0]!;
    expect(summary.observationStatus).toBe('partial');
    expect(summary.phases.map(phase => phase.retainedGpuMs)).toEqual([8, 8, 0, 0]);
  });

  it('rejects unbounded or non-finite GPU reports at the schema boundary', () => {
    const result = profile();
    expect(gpuProfileSchema.safeParse({ ...result, totalGpuMs: Infinity }).success).toBe(false);
    expect(gpuProfileSchema.safeParse({ ...result, rows: Array.from({ length: maximumGpuProfileGroups + 1 }, () => result.rows[0]) }).success).toBe(false);
    expect(gpuProfileSchema.safeParse({ ...result, measuredPasses: -1 }).success).toBe(false);
  });

  it('rejects forged cross-lane plans and non-matching reference runtime settings', () => {
    const plan = performancePlan();
    expect(planSchema.safeParse({ ...plan, settings: { ...plan.settings, mode: 'gpu-profile' } }).success).toBe(false);
    expect(planSchema.safeParse({ ...plan, options: { profile: gpuProfilingProfile } }).success).toBe(false);
    expect(planSchema.safeParse({ ...plan, settings: { ...plan.settings, mode: 'both' }, options: { profile: 'cpu-wasm32' } }).success).toBe(false);
  });
});
