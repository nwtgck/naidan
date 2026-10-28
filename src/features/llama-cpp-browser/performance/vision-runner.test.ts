// @vitest-environment node
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { createPerformanceRunner } from './runner';
import { createVisionPerformancePlan } from './plan';
import { performanceEnvironment, performancePlan, performanceReport } from '@/features/llama-cpp-browser/test-utils/performance.test-support';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import type { LlamaCppBrowserService, LlamaCppPerformanceScope } from '@/features/llama-cpp-browser/service-contract';
import { snapshotSchema } from './types';
import { performanceArchive } from './archive';
import { visionAdmission } from './vision.test-support';
import { trialRates, summarizePerformance } from './summary';

function setup({ mode, models }: { mode: 'standard' | 'gpu-profile', models: number }) {
  const plan = createVisionPerformancePlan(performancePlan({ repeats: 2, mode, models }));
  const generate = vi.fn<LlamaCppPerformanceScope['generate']>(async ({ onSummary, onEvent }) => {
    const report = performanceReport();
    report.performance!.input = 'multimodal';
    report.performance!.sessionPreparation = { projector: generate.mock.calls.length === 1 ? 'loaded' : 'reused', releasedTextContext: false };
    onSummary({ diagnostic: report });
    await onEvent({ event: { type: 'text', text: 'shapes' } });
    return { content: 'shapes', reasoningContent: '', toolCalls: [], finishReason: 'length' };
  });
  const service = {
    listModelEntries: vi.fn<LlamaCppBrowserService['listModelEntries']>(async () => plan.models),
    runPerformanceOperation: vi.fn<LlamaCppBrowserService['runPerformanceOperation']>(async ({ options, operation, signal }) => {
      await operation({ scope: { options, signal: signal ?? new AbortController().signal, generate } });
    }),
  };
  const kernel = vi.fn();
  let hidden = false;
  const runner = createPerformanceRunner({
    service,
    now: () => 100,
    date: () => plan.createdAt,
    hidden: () => hidden,
    waitUntilVisible: async () => {
      hidden = false;
    },
    publish: () => {},
    runKernelDiagnostic: kernel,
  });
  return {
    plan,
    generate,
    service,
    kernel,
    runner,
    hide: () => {
      hidden = true;
      runner.visibilityChanged();
    },
    start: () => runner.start({ plan, environment: performanceEnvironment() }),
  };
}

describe('image workload through the ordinary generation scope', () => {
  it('preserves requested storage evidence in the ZIP and separates equal image work by mode', async () => {
    const test = setup({ mode: 'standard', models: 1 });
    test.generate.mockImplementation(async ({ onSummary, onVisionAdmission }) => {
      const selectedMode = test.generate.mock.calls.length === 3 ? 'legacy-expand' : 'retain-checked';
      const storage = { preference: selectedMode, selectedMode, contextRequestedMode: selectedMode, capability: 'available', status: 'initialized', apiVersion: 1, evidence: 'requested-policy-only', reason: 'explicit' } as const;
      const admission = visionAdmission({ decision: 'ready' });
      admission.diagnostic.storage = storage;
      onVisionAdmission?.({ admission });
      const report = performanceReport();
      report.performance!.input = 'multimodal';
      report.performance!.sessionPreparation = { projector: test.generate.mock.calls.length === 1 ? 'loaded' : 'reused', releasedTextContext: false };
      report.performance!.visionStorage = storage;
      onSummary({ diagnostic: report });
      return { content: 'answer', reasoningContent: '', toolCalls: [], finishReason: 'stop' };
    });
    await test.start();
    const snapshot = test.runner.snapshot()!;
    const warm = summarizePerformance({ snapshot }).filter(group => group.scenario === 'image-warm');
    expect(warm.map(group => group.vision?.storage?.selectedMode)).toEqual(['retain-checked', 'legacy-expand']);
    expect(warm.map(group => group.count)).toEqual([1, 1]);
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot })).arrayBuffer());
    const records = (await zip.file('trials.jsonl')!.async('string')).trim().split('\n').map(line => JSON.parse(line));
    expect(records[1].summary.performance.visionStorage).toMatchObject({ selectedMode: 'retain-checked', contextRequestedMode: 'retain-checked', evidence: 'requested-policy-only' });
    expect(records[2].summary.performance.visionStorage.selectedMode).toBe('legacy-expand');
    expect(await zip.file('README.md')!.async('string')).toContain('not proof of GPU BF16 residency');
  });

  it.each(['standard', 'gpu-profile'] as const)('uses identical committed Blob bytes, fresh sequences and no automatic Q8 workload: %s', async mode => {
    const test = setup({ mode, models: 1 });
    await test.start();
    expect(test.service.runPerformanceOperation).toHaveBeenCalledOnce();
    expect(test.kernel).not.toHaveBeenCalled();
    expect(test.generate).toHaveBeenCalledTimes(3);
    const images: Blob[] = [];
    for (const [call] of test.generate.mock.calls) {
      expect(call.sequence).toBe('fresh');
      expect(call.observation).toBe('vision');
      expect(call.input).toMatchObject({ debug: 'off', temperature: 0, maxTokens: 32 });
      const content = call.input.messages[0]!.content;
      expect(Array.isArray(content)).toBe(true);
      if (typeof content !== 'string' && content[0]?.type === 'image') {
        images.push(content[0].blob);
      }
    }
    expect(images).toHaveLength(3);
    expect(images[0]).toBe(images[1]);
    expect(images[1]).toBe(images[2]);
    expect(images[0]!.size).toBe(test.plan.visionFixture?.bytes);
    const snapshot = test.runner.snapshot()!;
    expect(snapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.trials.map(trial => trial.vision?.residency)).toEqual(['cold', 'warm', 'warm']);
    expect(snapshot.trials.every(trial => trial.status === 'succeeded')).toBe(true);
    expect(snapshot.trials.every(trial => trial.input.every(message => typeof message.content === 'string'))).toBe(true);
    expect(trialRates({ trial: snapshot.trials[0]! }).prefillTokensPerSecond).toBeUndefined();
    const zip = await JSZip.loadAsync(await (await performanceArchive({ snapshot })).arrayBuffer());
    expect(await zip.file('README.md')!.async('string')).toContain('targeted-vision-en-v1');
    const metadata = JSON.parse(await zip.file('vision-fixture.json')!.async('string'));
    expect(metadata).toMatchObject({ imageBytesIncluded: false, decodedRgbIdentity: 'not-observed', pureLmPrefill: 'unavailable', physicalMemoryPeak: 'unavailable' });
    expect(Object.keys(zip.files).some(path => /\.png$|\.rgb$/.test(path))).toBe(false);
    const output = await zip.file(`outputs/${snapshot.trials[0]!.id}.json`)!.async('string');
    expect(output).not.toContain('base64');
    expect(JSON.parse(output).vision).toMatchObject({ residency: 'cold' });
  });

  it('retains unsupported failures and skips remaining work without fallback', async () => {
    const test = setup({ mode: 'standard', models: 1 });
    test.generate.mockImplementationOnce(async ({ onProgress, onSummary }) => {
      onProgress?.({ progress: { phase: 'prefill', completed: 0, total: 0 } });
      onSummary({ diagnostic: performanceReport({ outcome: 'failed' }) });
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    });
    await test.start();
    const snapshot = test.runner.snapshot()!;
    expect(test.generate).toHaveBeenCalledOnce();
    expect(snapshot.trials.map(trial => trial.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(snapshot.trials[0]).toMatchObject({ vision: { residency: 'cold' }, error: 'unsupported-input', lastProgress: { phase: 'prefill' }, summary: { performance: { outcome: 'failed' } } });
  });

  it('keeps hidden and aborted attempt evidence and does not continue the native scope', async () => {
    const test = setup({ mode: 'standard', models: 1 });
    test.generate.mockImplementationOnce(async ({ signal, onSummary }) => {
      test.hide();
      test.runner.stop();
      onSummary({ diagnostic: performanceReport({ outcome: 'aborted' }) });
      signal.throwIfAborted();
      throw new Error('unreachable');
    });
    await test.start();
    expect(test.generate).toHaveBeenCalledOnce();
    expect(test.runner.snapshot()).toMatchObject({ status: 'cancelled', trials: [expect.objectContaining({ status: 'cancelled', hiddenObserved: true, exclusion: expect.arrayContaining(['page-hidden']) }), expect.anything(), expect.anything()] });
  });
});

it('records an explicit native skip and proceeds to other models without counting it as a successful image run', async () => {
  const test = setup({ mode: 'standard', models: 2 });
  test.generate.mockImplementationOnce(async ({ onVisionAdmission }) => {
    onVisionAdmission?.({ admission: visionAdmission({ decision: 'missing-projector' }) });
    throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  });
  await test.start();
  const result = test.runner.snapshot()!;
  expect(result.trials.map(trial => trial.status)).toEqual(['skipped', 'skipped', 'skipped', 'succeeded', 'succeeded', 'succeeded']);
  expect(result.trials.slice(0, 3).every(trial => trial.skipReason === 'missing-projector')).toBe(true);
  expect(result.trials[0]?.visionAdmission).toMatchObject({ status: 'skipped', reason: 'missing-projector' });
  expect(result.modelErrors).toHaveLength(0);
  expect(test.generate).toHaveBeenCalledTimes(4);
});

it('does not count a reloaded projector after an interrupted cold request as warm', async () => {
  const test = setup({ mode: 'standard', models: 1 });
  test.generate.mockImplementationOnce(async ({ signal, onSummary }) => {
    const current = test.runner.snapshot()!.trials.at(-1)!;
    test.runner.interruptCurrent({ trialId: current.id });
    onSummary({ diagnostic: performanceReport({ outcome: 'aborted' }) });
    signal.throwIfAborted();
    throw new Error('unreachable');
  });
  test.generate.mockImplementationOnce(async ({ onVisionAdmission, onSummary }) => {
    const admission = visionAdmission({ decision: 'ready' });
    admission.diagnostic.rows.push({ ordinal: 1, observedMs: 0, event: 'operation-start', stage: 'projector-load' });
    onVisionAdmission?.({ admission });
    const report = performanceReport();
    report.performance!.sessionPreparation = { projector: 'reused', releasedTextContext: false };
    onSummary({ diagnostic: report });
    return { content: 'answer', reasoningContent: '', toolCalls: [], finishReason: 'stop' };
  });
  await test.start();
  const trial = test.runner.snapshot()!.trials[1]!;
  expect(test.service.runPerformanceOperation).toHaveBeenCalledTimes(2);
  expect(trial).toMatchObject({ status: 'succeeded', runtimeSegment: 1, vision: { residency: 'warm' } });
  expect(trial.warnings).toContain('runtime-restarted');
  expect(trial.exclusion).toContain('residency-unconfirmed');
});
