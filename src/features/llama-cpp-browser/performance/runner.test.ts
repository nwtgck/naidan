// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlamaCppBrowserService, LlamaCppPerformanceScope } from '@/features/llama-cpp-browser/service-contract';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { performanceEnvironment, performancePlan, performanceReport } from '@/features/llama-cpp-browser/test-utils/performance.test-support';
import { createPerformanceRunner } from './runner';
import { planSchema, snapshotSchema, type MeasurementMode } from './types';
import { summarizePerformance, performanceFindings } from './summary';

function setup({ models = 1, diagnostics = 'none', mode, repeats = 1 }: { repeats?: number, models?: number, diagnostics?: 'none' | 'placement', mode?: MeasurementMode } = {}) {
  const plan = performancePlan({ models, diagnostics, mode, repeats });
  const order: string[] = [];
  let clock = 0, hidden = false;
  const generate = vi.fn<LlamaCppPerformanceScope['generate']>(async ({ input, sequence, onEvent, onSummary }) => {
    order.push(input.model);
    clock += 100;
    await onEvent({ event: { type: 'reasoning', text: 'reasoning' } });
    clock += 100;
    await onEvent({ event: { type: 'text', text: 'answer' } });
    onSummary({ diagnostic: performanceReport({ reused: sequence === 'fresh' ? 0 : 32 }) });
    return { content: 'answer', reasoningContent: 'reasoning', toolCalls: [], finishReason: 'stop' };
  });
  const service = {
    listModels: vi.fn<LlamaCppBrowserService['listModels']>(async () => plan.models),
    runPerformanceOperation: vi.fn<LlamaCppBrowserService['runPerformanceOperation']>(async ({ options, signal, operation }) => {
      order.push('acquire');
      using _cleanupResource = {
        [Symbol.dispose]() {
          order.push('release');
        },
      };
      await operation({ scope: { options, signal: signal ?? new AbortController().signal, generate } });
    }),
  };
  const waitUntilVisible = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
    signal.throwIfAborted();
    hidden = false;
  });
  const publish = vi.fn<Parameters<typeof createPerformanceRunner>[0]['publish']>();
  const runner = createPerformanceRunner({
    service,
    now: () => clock,
    date: () => plan.createdAt,
    hidden: () => hidden,
    waitUntilVisible,
    publish,
  });
  return {
    publish,
    advance: (ms: number) => {
      clock += ms;
    },
    plan,
    runner,
    service,
    generate,
    order,
    waitUntilVisible,
    hide: () => {
      hidden = true;
      runner.visibilityChanged();
    },
    start: () => runner.start({ plan, environment: performanceEnvironment() }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('in-memory sequential performance measurement', () => {
  it('adds repeated blocks only when explicitly requested and reuses their measured parent', () => {
    const plan = performancePlan({ models: 2, repeats: 3 });
    expect(plan.steps).toHaveLength(26);
    expect(plan.steps.filter(step => step.role === 'measurement')).toHaveLength(26);
    expect(plan.steps.filter(step => step.sequence === 'continue')).toHaveLength(6);
    expect(plan.steps.every(step => (step.sequence === 'continue') === Boolean(step.dependsOn))).toBe(true);
  });

  it('owns one model at a time, retains exact parent output, and performs no alternate inference', async () => {
    const test = setup({ models: 2 });
    await test.start();
    expect(test.order).toEqual(['acquire', ...Array(5).fill('model0.gguf'), 'release', 'acquire', ...Array(5).fill('model1.gguf'), 'release']);
    expect(test.generate).toHaveBeenCalledTimes(10);
    const snapshot = snapshotSchema.parse(test.runner.snapshot());
    expect(snapshot.status).toBe('completed');
    expect(new Set(snapshot.trials.map(trial => trial.id)).size).toBe(10);
    expect(snapshot.trials.every(trial => trial.status === 'succeeded' && !trial.exclusion.length)).toBe(true);
    expect(snapshot.trials[0]).toMatchObject({ firstReceivedMs: 100, firstReasoningMs: 100, firstTextMs: 200, elapsedMs: 200 });
    const followup = test.generate.mock.calls[2]![0];
    expect(followup.input.messages).toEqual([snapshot.trials[1]!.input[0], { role: 'assistant', content: 'answer', reasoning_content: 'reasoning' }, { role: 'user', content: test.plan.steps[2]!.prompt }]);
    for (const [index, [call]] of test.generate.mock.calls.entries()) {
      expect(call.input).toMatchObject({ temperature: 0, topP: 1, debug: 'off', maxTokens: test.plan.steps[index]!.maxTokens });
    }
    expect(summarizePerformance({ snapshot })).toHaveLength(10);
  });

  it('rejects changed model inventory without beginning that model', async () => {
    const test = setup();
    test.service.listModels.mockResolvedValue([{ ...test.plan.models[0]!, importedAt: 2 }]);
    await test.start();
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.runner.snapshot()?.trials.every(trial => trial.status === 'skipped')).toBe(true);
    expect(test.runner.snapshot()?.modelErrors[0]?.error).toContain('inventory changed');
  });

  it('records a model failure, retires that model, and continues with the next model', async () => {
    const test = setup({ models: 2 });
    test.generate.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'runtime-error' }));
    await test.start();
    expect(test.generate).toHaveBeenCalledTimes(6);
    const snapshot = test.runner.snapshot()!;
    expect(snapshot.trials[0]?.status).toBe('failed');
    expect(snapshot.trials.slice(1, 5).every(trial => trial.status === 'skipped')).toBe(true);
    expect(snapshot.trials.slice(5).every(trial => trial.status === 'succeeded')).toBe(true);
  });

  it('preserves a cooperative cancellation summary and partial output; drops late events', async () => {
    const test = setup({ models: 2 });
    let late: Parameters<LlamaCppPerformanceScope['generate']>[0] | undefined;
    test.generate.mockImplementationOnce(async args => {
      late = args;
      await args.onEvent({ event: { type: 'text', text: 'partial' } });
      test.runner.stop();
      args.onSummary({ diagnostic: performanceReport({ outcome: 'aborted' }) });
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    await test.start();
    expect(test.runner.snapshot()?.status).toBe('cancelled');
    const trial = test.runner.snapshot()!.trials[0]!;
    expect(trial.partialText).toBe('partial');
    expect(trial.summary?.performance?.outcome).toBe('aborted');
    await late!.onEvent({ event: { type: 'text', text: 'too late' } });
    late!.onSummary({ diagnostic: performanceReport() });
    expect(trial.partialText).toBe('partial');
    expect(trial.summary?.performance?.outcome).toBe('aborted');
    expect(test.generate).toHaveBeenCalledOnce();
  });

  it('aborts timed out inference and waits for it to settle instead of racing the next model', async () => {
    vi.useFakeTimers();
    const test = setup();
    test.generate.mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new LlamaCppBrowserError({ code: 'aborted' })), { once: true });
    }));
    const pending = test.start();
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    expect(test.runner.snapshot()?.trials[0]).toMatchObject({ status: 'failed', error: 'trial-timeout' });
    expect(test.generate).toHaveBeenCalledOnce();
  });

  it('excludes hidden trials without replacing a slow measurement or hiding raw evidence', async () => {
    const test = setup();
    const original = test.generate.getMockImplementation()!;
    test.generate.mockImplementationOnce(async args => {
      test.hide();
      return original(args);
    });
    await test.start();
    expect(test.runner.snapshot()?.trials).toHaveLength(5);
    expect(test.runner.snapshot()?.trials[0]?.exclusion).toContain('page-hidden');
    expect(summarizePerformance({ snapshot: test.runner.snapshot()! }).some(group => group.scenario === 'initial')).toBe(false);
    expect(test.waitUntilVisible).toHaveBeenCalledTimes(6);
  });

  it('does not fabricate a continuation after an empty preparation', async () => {
    const test = setup();
    const original = test.generate.getMockImplementation()!;
    let calls = 0;
    test.generate.mockImplementation(async args => {
      const result = await original(args);
      calls++;
      return calls === 2 ? { ...result, content: '', reasoningContent: '' } : result;
    });
    await test.start();
    expect(test.generate).toHaveBeenCalledTimes(4);
    expect(test.runner.snapshot()?.trials[2]?.status).toBe('skipped');
  });

  it('separates truncated-parent continuations while excluding unexpected fresh reuse', async () => {
    const test = setup();
    const original = test.generate.getMockImplementation()!;
    test.generate.mockImplementation(async args => {
      const result = await original(args);
      args.onSummary({ diagnostic: performanceReport({ reused: 8 }) });
      return { ...result, finishReason: 'length' };
    });
    await test.start();
    expect(test.runner.snapshot()?.trials[0]?.exclusion).toContain('unexpected-reuse');
    expect(test.runner.snapshot()?.trials[2]?.warnings).toContain('incomplete-parent');
    expect(summarizePerformance({ snapshot: test.runner.snapshot()! })).toMatchObject([{ scenario: 'continuation', parentFinishReason: 'length', count: 1 }]);
  });

  it('records missing metrics as missing, never zero', async () => {
    const test = setup();
    test.generate.mockResolvedValue({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    await test.start();
    expect(test.runner.snapshot()?.trials[0]?.exclusion).toContain('missing-summary');
    expect(test.runner.snapshot()?.trials[0]?.exclusion).not.toContain('unexpected-reuse');
    expect(test.runner.snapshot()?.trials[0]?.firstReceivedMs).toBeUndefined();
  });

  it('rejects overlapping starts', async () => {
    const test = setup();
    const gate = Promise.withResolvers<void>();
    test.waitUntilVisible.mockImplementationOnce(async () => gate.promise);
    const first = test.start();
    await expect(test.start()).rejects.toThrow('already running');
    test.runner.stop();
    gate.resolve();
    await first;
    expect(test.generate).not.toHaveBeenCalled();
  });
});

describe('measurement ownership and surviving failure evidence', () => {
  it('stops a hidden-page wait when the owning service cancels, and never starts the next model', async () => {
    const test = setup({ models: 2 });
    const owner = new AbortController();
    test.service.runPerformanceOperation.mockImplementationOnce(async ({ options, operation }) => operation({ scope: { options, signal: owner.signal, generate: test.generate } }));
    test.waitUntilVisible.mockImplementationOnce(async () => {});
    test.waitUntilVisible.mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const pending = test.start();
    await vi.waitFor(() => expect(test.waitUntilVisible).toHaveBeenCalledTimes(2));
    owner.abort();
    await pending;
    expect(test.runner.snapshot()?.status).toBe('cancelled');
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.service.runPerformanceOperation).toHaveBeenCalledOnce();
  });

  it('detaches from the scope before ordinary model cleanup aborts that scope', async () => {
    const test = setup({ models: 2 });
    test.service.runPerformanceOperation.mockImplementation(async ({ options, operation }) => {
      const owner = new AbortController();
      using _cleanupResource = {
        [Symbol.dispose]() {
          owner.abort();
        },
      };
      await operation({ scope: { options, signal: owner.signal, generate: test.generate } });
    });
    await test.start();
    expect(test.runner.snapshot()?.status).toBe('completed');
    expect(test.generate).toHaveBeenCalledTimes(10);
  });

  it('keeps the last loading progress when the worker dies without a terminal summary', async () => {
    const test = setup();
    let late: Parameters<LlamaCppPerformanceScope['generate']>[0]['onProgress'];
    test.generate.mockImplementationOnce(async ({ onProgress }) => {
      late = onProgress;
      onProgress?.({ progress: { phase: 'loading', completed: 0.75, total: 1 } });
      throw new LlamaCppBrowserError({ code: 'worker-failed' });
    });
    await test.start();
    const trial = test.runner.snapshot()!.trials[0]!;
    expect(trial).toMatchObject({ status: 'failed', error: 'worker-failed', lastProgress: { phase: 'loading', completed: 0.75, total: 1 }, lastProgressMs: 0 });
    expect(trial.summary).toBeUndefined();
    late?.({ progress: { phase: 'generating', completed: 100, total: 100 } });
    expect(trial.lastProgress?.phase).toBe('loading');
  });
});

it('runs one final instrumented census outside speed aggregates and never requests it for speed trials', async () => {
  const test = setup({ diagnostics: 'placement' });
  await test.start();
  expect(test.generate).toHaveBeenCalledTimes(6);
  expect(test.generate.mock.calls.map(([call]) => call.observation)).toEqual([undefined, undefined, undefined, undefined, undefined, 'placement']);
  const snapshot = test.runner.snapshot()!;
  expect(snapshot.trials.at(-1)?.exclusion).toEqual(['instrumented']);
  expect(snapshot.trials.at(-1)?.warnings).toEqual(['placement-missing']);
  expect(summarizePerformance({ snapshot }).map(group => group.scenario)).not.toContain('placement');
});

describe('orchestration timing, separate from inference', () => {
  it('records hidden waits between trials rather than charging them to GPU time', async () => {
    const test = setup();
    let calls = 0;
    test.waitUntilVisible.mockImplementation(async ({ signal }) => {
      signal.throwIfAborted();
      if (++calls === 3) {
        test.hide();
        test.advance(13000);
      }
      if (calls === 6) {
        test.hide();
        test.advance(61000);
      }
    });
    await test.start();
    const snapshot = snapshotSchema.parse(test.runner.snapshot());
    expect(snapshot.execution?.elapsedMs).toBe(75000);
    expect(snapshot.trials.reduce((sum, trial) => sum + (trial.elapsedMs ?? 0), 0)).toBe(1000);
    expect(snapshot.execution?.intervals.filter(part => part.elapsedMs > 1000).map(part => [part.kind, part.elapsedMs])).toEqual([['visibility-wait', 13000], ['visibility-wait', 61000]]);
    expect(snapshot.trials.map(trial => trial.startedMs)).toEqual([0, 13200, 13400, 13600, 74800]);
    expect(snapshot.execution?.visibility.some(event => event.hidden)).toBe(true);
    expect(snapshot.execution?.finishedAt).toBeDefined();
  });

  it('accounts for cancellation while waiting and bounds visibility history', async () => {
    const test = setup();
    test.waitUntilVisible.mockImplementationOnce(async ({ signal }) => {
      for (let index = 0; index < 300; index++) {
        test.hide();
      }
      test.advance(7000);
      test.runner.stop();
      signal.throwIfAborted();
    });
    await test.start();
    const snapshot = snapshotSchema.parse(test.runner.snapshot());
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.execution).toMatchObject({ elapsedMs: 7000, droppedVisibilityEvents: 45 });
    expect(snapshot.execution?.visibility).toHaveLength(256);
    expect(snapshot.execution?.intervals).toContainEqual(expect.objectContaining({ kind: 'visibility-wait', elapsedMs: 7000, outcome: 'cancelled' }));
    expect(test.generate).not.toHaveBeenCalled();
    test.hide();
    expect(snapshot.execution?.visibility).toHaveLength(256);
  });
});

it('retains diagnostic capability and truncation warnings despite successful generation', async () => {
  const test = setup({ diagnostics: 'placement' });
  const original = test.generate.getMockImplementation()!;
  test.generate.mockImplementation(async args => {
    const result = await original(args);
    if (args.observation === 'placement') {
      const diagnostic = performanceReport();
      diagnostic.performance!.backendCensus = {
        version: 1,
        method: 'native-eval-metadata',
        timing: 'not-a-speed-measurement',
        placementMeaning: 'destination-buffer-not-execution-backend',
        capability: 'tensor-layout-only',
        observedNodes: 12,
        droppedNodes: 1,
        errors: 1,
        entries: [],
      };
      args.onSummary({ diagnostic });
    }
    return result;
  });
  await test.start();
  const snapshot = snapshotSchema.parse(test.runner.snapshot());
  expect(snapshot.trials.at(-1)).toMatchObject({ status: 'succeeded', exclusion: ['instrumented'], warnings: ['placement-layout-only', 'placement-incomplete'] });
  expect(snapshot.trials.slice(0, -1).every(trial => !trial.warnings.length)).toBe(true);
});

it('retains failed-attempt memory and rejects late evidence from the previous model', async () => {
  const test = setup({ models: 2 });
  let late: Parameters<LlamaCppPerformanceScope['generate']>[0] | undefined;
  const memory = { samples: [], droppedSamples: 0, nativeAllocations: [], droppedNativeAllocations: 0, nativeSettings: [], droppedNativeSettings: 0 };
  test.generate.mockImplementationOnce(async args => {
    late = args;
    args.onMemoryDiagnostics?.({ memory });
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  });
  await test.start();
  const trials = test.runner.snapshot()!.trials;
  expect(trials[0]?.memoryDiagnostics).toEqual(memory);
  expect(trials[0]?.status).toBe('failed');
  expect(trials.some(trial => trial.modelIndex === 1 && trial.status === 'succeeded')).toBe(true);
  late!.onMemoryDiagnostics?.({ memory: { ...memory, droppedSamples: 99 } });
  expect(trials[0]?.memoryDiagnostics?.droppedSamples).toBe(0);
  expect(trials.filter(trial => trial.modelIndex === 1).every(trial => trial.memoryDiagnostics === undefined)).toBe(true);
});

it.each(['errors', 'skippedNodes', 'unattributedNodes', 'unfinishedNodes', 'untimed'] as const)('excludes and marks incomplete diagnostic completion timing with %s', failure => {
  const test = setup({ diagnostics: 'placement' });
  const original = test.generate.getMockImplementation()!;
  test.generate.mockImplementation(async args => {
    const result = await original(args);
    if (args.observation === 'placement') {
      const diagnostic = performanceReport();
      const timing = {
        method: 'per-node-synchronized-wall-time' as const,
        requestedNodes: 1,
        completedNodes: 1,
        timedNodes: 1,
        unattributedNodes: 0,
        unfinishedNodes: 0,
        skippedNodes: 0,
        errors: 0,
        totalMs: 20,
      };
      if (failure === 'untimed') {
        timing.timedNodes = 0;
      } else {
        timing[failure] = 1;
      }
      diagnostic.performance!.backendCensus = {
        version: 1,
        method: 'native-eval-metadata',
        timing: 'not-a-speed-measurement',
        placementMeaning: 'destination-buffer-not-execution-backend',
        capability: 'synchronous-leaf-bindings-v1',
        observedNodes: 1,
        droppedNodes: 0,
        errors: 0,
        entries: [],
        decodeCompletionTiming: timing,
      };
      args.onSummary({ diagnostic });
    }
    return result;
  });
  return test.start().then(() => {
    const snapshot = snapshotSchema.parse(test.runner.snapshot());
    expect(snapshot.trials.at(-1)).toMatchObject({ status: 'succeeded', exclusion: ['instrumented'], warnings: ['placement-incomplete'] });
    expect(snapshot.trials.slice(0, -1).every(trial => !trial.warnings.length)).toBe(true);
    expect(summarizePerformance({ snapshot }).every(group => group.scenario !== 'placement')).toBe(true);
  });
});

describe('runtime profiling lane isolation', () => {
  it('runs both complete plans serially, releases each worker scope and doubles calls rather than mixing contexts', async () => {
    const test = setup({ models: 2, diagnostics: 'placement', mode: 'both' });
    await test.start();
    expect(test.order).toEqual([0, 0, 1, 1].flatMap(index => ['acquire', ...Array(6).fill(`model${index}.gguf`), 'release']));
    expect(test.service.runPerformanceOperation.mock.calls.map(([args]) => args.options.profile)).toEqual(['webgpu-wasm64-jspi', 'webgpu-wasm64-jspi-gpu-profile', 'webgpu-wasm64-jspi', 'webgpu-wasm64-jspi-gpu-profile']);
    const snapshot = snapshotSchema.parse(test.runner.snapshot());
    expect(snapshot.trials).toHaveLength(24);
    expect(snapshot.trials.every(trial => trial.status === 'succeeded')).toBe(true);
    const diagnostic = snapshot.trials.filter(trial => trial.lane === 'gpu-profile');
    expect(diagnostic).toHaveLength(12);
    expect(diagnostic.every(trial => trial.exclusion.includes('instrumented') && trial.warnings.includes('gpu-profile-missing'))).toBe(true);
    expect(snapshot.execution?.intervals.filter(interval => interval.kind === 'model-release').map(interval => interval.lane)).toEqual(['standard', 'gpu-profile', 'standard', 'gpu-profile']);
    expect(summarizePerformance({ snapshot })).toHaveLength(10);
    for (const start of [0, 6, 12, 18]) {
      expect(snapshot.trials[start + 2]!.input[1]?.content).toBe(snapshot.trials[start + 1]!.output?.content);
    }
  });

  it('has no ordinary-speed aggregates when only profiling is requested', async () => {
    const test = setup({ mode: 'gpu-profile' });
    await test.start();
    expect(test.generate).toHaveBeenCalledTimes(5);
    const snapshot = snapshotSchema.parse(test.runner.snapshot());
    expect(snapshot.trials.every(trial => trial.options.profile === 'webgpu-wasm64-jspi-gpu-profile' && trial.exclusion.includes('instrumented'))).toBe(true);
    expect(summarizePerformance({ snapshot })).toEqual([]);
  });

  it('keeps the other lane after one lane fails instead of claiming a silent fallback', async () => {
    const test = setup({ mode: 'both' });
    test.generate.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'runtime-error' }));
    await test.start();
    const snapshot = snapshotSchema.parse(test.runner.snapshot());
    expect(snapshot.trials.slice(0, 5).map(trial => trial.status)).toEqual(['failed', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(snapshot.trials.slice(5).every(trial => trial.lane === 'gpu-profile' && trial.status === 'succeeded')).toBe(true);
    expect(test.service.runPerformanceOperation).toHaveBeenCalledTimes(2);
  });

  it('cancels remaining lanes without creating another worker and preserves lane identities for skipped calls', async () => {
    const test = setup({ mode: 'both' });
    test.generate.mockImplementationOnce(async () => {
      test.runner.stop();
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    await test.start();
    const snapshot = snapshotSchema.parse(test.runner.snapshot());
    expect(snapshot.status).toBe('cancelled');
    expect(test.service.runPerformanceOperation).toHaveBeenCalledOnce();
    expect(snapshot.trials.slice(5).every(trial => trial.status === 'skipped' && trial.lane === 'gpu-profile' && trial.options.profile === 'webgpu-wasm64-jspi-gpu-profile')).toBe(true);
  });

  it('rejects cross-lane continuations, mismatched modes and an accidentally selected diagnostic chat profile', () => {
    const plan = performancePlan({ mode: 'both' });
    const continuation = plan.steps.find(step => step.lane === 'gpu-profile' && step.dependsOn)!;
    continuation.dependsOn = plan.steps[1]!.id;
    expect(planSchema.safeParse(plan).success).toBe(false);
    const normal = performancePlan();
    normal.steps[0]!.lane = 'gpu-profile';
    expect(planSchema.safeParse(normal).success).toBe(false);
    const wrong = performancePlan();
    wrong.options.profile = 'webgpu-wasm64-jspi-gpu-profile';
    expect(planSchema.safeParse(wrong).success).toBe(false);
  });
});

function runningId({ test }: { test: ReturnType<typeof setup> }): string {
  return test.runner.snapshot()!.trials.find(trial => trial.status === 'running')!.id;
}

describe('interrupt only the current performance trial', () => {
  it.each([undefined, 'gpu-profile', 'both'] as const)('keeps partial evidence and skips only dependent continuation in %s mode', async mode => {
    const test = setup({ models: 2, diagnostics: 'placement', mode });
    const normal = test.generate.getMockImplementation()!;
    test.generate.mockImplementationOnce(normal).mockImplementationOnce(async args => {
      const id = runningId({ test });
      expect(test.runner.canInterruptCurrent({ trialId: id })).toBe(true);
      await args.onEvent({ event: { type: 'text', text: 'partial answer' } });
      test.advance(50);
      expect(test.runner.interruptCurrent({ trialId: id })).toBe(true);
      expect(args.signal.aborted).toBe(true);
      expect(test.service.runPerformanceOperation.mock.calls[0]![0].signal?.aborted).toBe(false);
      expect(test.runner.canInterruptCurrent({ trialId: id })).toBe(false);
      await args.onEvent({ event: { type: 'reasoning', text: 'drained reasoning' } });
      test.advance(75);
      args.onMemoryDiagnostics?.({ memory: { samples: [], droppedSamples: 0, nativeAllocations: [], droppedNativeAllocations: 0, nativeSettings: [], droppedNativeSettings: 0 } });
      args.onSummary({ diagnostic: performanceReport({ outcome: 'aborted' }) });
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    await test.start();
    const snapshot = snapshotSchema.parse(test.runner.snapshot());
    expect(snapshot.status).toBe('completed');
    expect(snapshot.modelErrors).toEqual([]);
    expect(snapshot.trials[1]).toMatchObject({ status: 'interrupted', runtimeSegment: 0, partialText: 'partial answer', partialReasoning: 'drained reasoning', interruption: { reason: 'user-skip', requestedMs: 50, settledMs: 125, recovery: 'new-scope' }, summary: { performance: { outcome: 'aborted' } }, memoryDiagnostics: { samples: [] } });
    expect(snapshot.trials[2]).toMatchObject({ status: 'skipped', skipReason: 'dependency-interrupted', input: [], exclusion: ['dependency-unavailable'] });
    expect(snapshot.trials[3]).toMatchObject({ status: 'succeeded', runtimeSegment: 1, warnings: expect.arrayContaining(['runtime-restarted']) });
    expect(snapshot.trials[4]).toMatchObject({ status: 'succeeded', runtimeSegment: 1 });
    expect(snapshot.trials.slice(6).every(trial => trial.status === 'succeeded' && trial.runtimeSegment === 0)).toBe(true);
    expect(test.order.slice(0, 8)).toEqual(['acquire', 'model0.gguf', 'release', 'acquire', 'model0.gguf', 'model0.gguf', 'model0.gguf', 'release']);
    const expected = mode === 'both' ? 24 : 12;
    expect(snapshot.trials).toHaveLength(expected);
    expect(test.generate).toHaveBeenCalledTimes(expected - 1);
    expect(test.service.runPerformanceOperation).toHaveBeenCalledTimes((mode === 'both' ? 4 : 2) + 1);
    expect(snapshot.execution?.intervals).toContainEqual(expect.objectContaining({ kind: 'model-release', runtimeSegment: 0, outcome: 'interrupted' }));
    expect(summarizePerformance({ snapshot }).some(group => group.scenario === 'short' && group.position === 'before' && group.modelIndex === 0)).toBe(false);
  });

  it.each([0, 2, 3, 4, 5])('interrupts step %i without retrying it or changing other independent work', async index => {
    const test = setup({ diagnostics: 'placement' });
    const normal = test.generate.getMockImplementation()!;
    let calls = 0;
    test.generate.mockImplementation(async args => {
      if (calls++ === index) {
        test.runner.interruptCurrent({ trialId: runningId({ test }) });
        throw new LlamaCppBrowserError({ code: 'aborted' });
      }
      return normal(args);
    });
    await test.start();
    const result = snapshotSchema.parse(test.runner.snapshot());
    expect(result.trials).toHaveLength(6);
    expect(result.trials[index]).toMatchObject({ status: 'interrupted', interruption: { recovery: index === 5 ? 'not-needed' : 'new-scope' } });
    expect(result.trials.filter(trial => trial.status === 'skipped')).toEqual([]);
    expect(test.generate).toHaveBeenCalledTimes(6);
    expect(test.service.runPerformanceOperation).toHaveBeenCalledTimes(index === 5 ? 1 : 2);
    expect(test.service.listModels).toHaveBeenCalledTimes(index === 5 ? 1 : 2);
  });

  it('waits for generation settlement and asynchronous scope retirement before reacquiring', async () => {
    const test = setup();
    const aborted = Promise.withResolvers<void>(), settle = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    using _cleanup = {
      [Symbol.dispose]() {
        settle.resolve();
        released.resolve();
        test.runner.stop();
      },
    };
    test.generate.mockImplementationOnce(async args => {
      test.runner.interruptCurrent({ trialId: runningId({ test }) });
      aborted.resolve();
      await settle.promise;
      args.onSummary({ diagnostic: performanceReport({ outcome: 'aborted' }) });
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    test.service.runPerformanceOperation.mockImplementationOnce(async ({ options, signal, operation }) => {
      await using _retirement = {
        async [Symbol.asyncDispose]() {
          await released.promise;
          test.order.push('retired');
        },
      };
      await operation({ scope: { options, signal: signal!, generate: test.generate } });
    });
    const pending = test.start();
    await aborted.promise;
    expect(test.runner.snapshot()!.trials[0]).toMatchObject({ status: 'running', interruption: { recovery: 'pending' } });
    expect(test.service.runPerformanceOperation).toHaveBeenCalledOnce();
    settle.resolve();
    await vi.waitFor(() => expect(test.runner.snapshot()!.trials[0]?.status).toBe('interrupted'));
    expect(test.service.runPerformanceOperation).toHaveBeenCalledOnce();
    released.resolve();
    await pending;
    expect(test.order[0]).toBe('retired');
    expect(test.order[1]).toBe('acquire');
    expect(test.runner.snapshot()!.trials[1]?.runtimeSegment).toBe(1);
  });

  it('rejects duplicate, stale, idle and pre-acquisition clicks', async () => {
    const test = setup();
    expect(test.runner.interruptCurrent({ trialId: 'stale' })).toBe(false);
    let previous = '';
    const normal = test.generate.getMockImplementation()!;
    test.generate.mockImplementationOnce(async () => {
      previous = runningId({ test });
      expect(test.runner.interruptCurrent({ trialId: previous })).toBe(true);
      expect(test.runner.interruptCurrent({ trialId: previous })).toBe(false);
      throw new LlamaCppBrowserError({ code: 'aborted' });
    }).mockImplementationOnce(async args => {
      expect(test.runner.interruptCurrent({ trialId: previous })).toBe(false);
      expect(args.signal.aborted).toBe(false);
      return normal(args);
    });
    await test.start();
    expect(test.runner.interruptCurrent({ trialId: previous })).toBe(false);
    expect(test.runner.snapshot()!.trials.filter(trial => trial.status === 'interrupted')).toHaveLength(1);
  });

  it('accepts a click in the initial publish without even starting the native request', async () => {
    const test = setup();
    let handled = false;
    test.publish.mockImplementation(({ current }) => {
      if (current && !handled) {
        handled = true;
        expect(test.runner.interruptCurrent({ trialId: current.id })).toBe(true);
      }
    });
    await test.start();
    expect(test.generate).toHaveBeenCalledTimes(4);
    expect(test.runner.snapshot()!.trials[0]).toMatchObject({ status: 'interrupted', partialText: '', receivedEvents: 0 });
  });

  it('never reclassifies a timeout that won the race as a user interruption', async () => {
    vi.useFakeTimers();
    const test = setup();
    let id = '';
    test.generate.mockImplementationOnce(async ({ signal }) => {
      id = runningId({ test });
      await new Promise<void>(resolve => signal.addEventListener('abort', () => {
        expect(test.runner.interruptCurrent({ trialId: id })).toBe(false);
        resolve();
      }, { once: true }));
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    const pending = test.start();
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    expect(test.runner.snapshot()!.trials[0]).toMatchObject({ status: 'failed', error: 'trial-timeout' });
    expect(test.runner.snapshot()!.trials[0]?.interruption).toBeUndefined();
    expect(test.service.runPerformanceOperation).toHaveBeenCalledOnce();
  });

  it('does not let the timer turn a pending user interruption into a timeout', async () => {
    vi.useFakeTimers();
    const test = setup();
    test.generate.mockImplementationOnce(async () => {
      test.runner.interruptCurrent({ trialId: runningId({ test }) });
      await new Promise(resolve => setTimeout(resolve, 5000));
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    const pending = test.start();
    await vi.advanceTimersByTimeAsync(5001);
    await pending;
    expect(test.runner.snapshot()!.trials[0]).toMatchObject({ status: 'interrupted', error: 'aborted' });
    expect(test.runner.snapshot()!.status).toBe('completed');
  });

  it('retains a result that arrives concurrently with interruption, without counting it as success', async () => {
    const test = setup();
    const normal = test.generate.getMockImplementation()!;
    test.generate.mockImplementationOnce(async args => {
      const result = await normal(args);
      test.runner.interruptCurrent({ trialId: runningId({ test }) });
      return result;
    });
    await test.start();
    expect(test.runner.snapshot()!.trials[0]).toMatchObject({ status: 'interrupted', output: { content: 'answer' }, summary: { performance: { outcome: 'completed' } } });
    expect(summarizePerformance({ snapshot: test.runner.snapshot()! }).map(row => row.scenario)).not.toContain('initial');
  });

  it('drops late callbacks from the interrupted request instead of contaminating the new scope', async () => {
    const test = setup();
    const normal = test.generate.getMockImplementation()!;
    let late: Parameters<LlamaCppPerformanceScope['generate']>[0] | undefined;
    test.generate.mockImplementationOnce(async args => {
      late = args;
      args.onProgress?.({ progress: { phase: 'loading', completed: 0.1, total: 1 } });
      test.runner.interruptCurrent({ trialId: runningId({ test }) });
      throw new LlamaCppBrowserError({ code: 'aborted' });
    }).mockImplementationOnce(async args => {
      await late!.onEvent({ event: { type: 'text', text: 'too late' } });
      late!.onSummary({ diagnostic: performanceReport() });
      late!.onProgress?.({ progress: { phase: 'generating', completed: 1, total: 1 } });
      late!.onMemoryDiagnostics?.({ memory: { samples: [], droppedSamples: 0, nativeAllocations: [], droppedNativeAllocations: 0, nativeSettings: [], droppedNativeSettings: 0 } });
      return normal(args);
    });
    await test.start();
    const trial = test.runner.snapshot()!.trials[0]!;
    expect(trial.partialText).toBe('');
    expect(trial.summary).toBeUndefined();
    expect(trial.memoryDiagnostics).toBeUndefined();
    expect(trial.lastProgress?.phase).toBe('loading');
    expect(trial.firstReceivedMs).toBeUndefined();
  });

  it('prioritizes Stop while interruption is settling and never acquires another scope', async () => {
    const test = setup({ mode: 'both', models: 2 });
    test.generate.mockImplementationOnce(async args => {
      test.runner.interruptCurrent({ trialId: runningId({ test }) });
      test.runner.stop();
      args.onSummary({ diagnostic: performanceReport({ outcome: 'aborted' }) });
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    await test.start();
    expect(test.runner.snapshot()!.trials[0]).toMatchObject({ status: 'cancelled', interruption: { recovery: 'stopped' }, summary: { performance: { outcome: 'aborted' } } });
    expect(test.runner.snapshot()!.trials.slice(1).every(trial => trial.status === 'skipped')).toBe(true);
    expect(test.service.runPerformanceOperation).toHaveBeenCalledOnce();
  });

  it('honors Stop in the gap after retirement and before reacquisition', async () => {
    const test = setup();
    test.generate.mockImplementationOnce(async () => {
      test.runner.interruptCurrent({ trialId: runningId({ test }) });
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    test.publish.mockImplementation(({ snapshot, current }) => {
      if (!current && snapshot.execution?.intervals.some(part => part.kind === 'model-release')) {
        test.runner.stop();
      }
    });
    await test.start();
    expect(test.runner.snapshot()!.status).toBe('cancelled');
    expect(test.runner.snapshot()!.trials[0]?.interruption?.recovery).toBe('stopped');
    expect(test.service.runPerformanceOperation).toHaveBeenCalledOnce();
  });

  it('revalidates the model inventory on recovery instead of loading a replacement', async () => {
    const test = setup({ models: 2 });
    test.generate.mockImplementationOnce(async () => {
      test.runner.interruptCurrent({ trialId: runningId({ test }) });
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    test.service.listModels.mockResolvedValueOnce(test.plan.models).mockResolvedValueOnce(test.plan.models.map(model => ({ ...model, importedAt: 999 })));
    await test.start();
    expect(test.runner.snapshot()!.trials[0]?.interruption?.recovery).toBe('failed');
    expect(test.runner.snapshot()!.modelErrors[0]?.error).toContain('inventory changed');
    expect(test.runner.snapshot()!.trials.slice(1, 5).every(trial => trial.status === 'skipped')).toBe(true);
    expect(test.runner.snapshot()!.trials.slice(5).every(trial => trial.status === 'succeeded')).toBe(true);
  });

  it('does not disguise a failed retirement as an ordinary skip and continue loop', async () => {
    const test = setup({ models: 2 });
    test.generate.mockImplementationOnce(async () => {
      test.runner.interruptCurrent({ trialId: runningId({ test }) });
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    const original = test.service.runPerformanceOperation.getMockImplementation()!;
    test.service.runPerformanceOperation.mockImplementationOnce(async args => {
      await original(args).catch(() => {});
      throw new LlamaCppBrowserError({ code: 'worker-failed' });
    });
    await test.start();
    expect(test.runner.snapshot()!.trials[0]?.interruption?.recovery).toBe('failed');
    expect(test.runner.snapshot()!.modelErrors[0]?.error).toContain('worker-failed');
    expect(test.service.runPerformanceOperation).toHaveBeenCalledTimes(2);
  });

  it('excludes before/after speed comparisons spanning an interruption-induced restart', async () => {
    const test = setup();
    const normal = test.generate.getMockImplementation()!;
    let count = 0;
    test.generate.mockImplementation(async args => {
      if (++count === 3) {
        test.runner.interruptCurrent({ trialId: runningId({ test }) });
        throw new LlamaCppBrowserError({ code: 'aborted' });
      }
      return normal(args);
    });
    await test.start();
    const result = performanceFindings({ snapshot: test.runner.snapshot()! })[0]!;
    expect(result.reasons).toContain('different-runtime-segment');
    expect(result.afterToBeforeRatio).toBeUndefined();
    expect(result).toMatchObject({ beforeRuntimeSegment: 0, afterRuntimeSegment: 1 });
  });

  it('does not allocate a new scope when only transitive dependent steps remain', async () => {
    const test = setup();
    test.plan.steps = test.plan.steps.slice(0, 3).map((step, index, all) => ({ ...step, dependsOn: index ? all[index - 1]!.id : undefined, sequence: index ? 'continue' : 'fresh' }));
    test.generate.mockImplementationOnce(async () => {
      test.runner.interruptCurrent({ trialId: runningId({ test }) });
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    await test.start();
    expect(test.runner.snapshot()!.trials.map(trial => trial.status)).toEqual(['interrupted', 'skipped', 'skipped']);
    expect(test.runner.snapshot()!.trials.slice(1).every(trial => trial.skipReason === 'dependency-interrupted')).toBe(true);
    expect(test.runner.snapshot()!.trials[0]?.interruption?.recovery).toBe('not-needed');
    expect(test.service.runPerformanceOperation).toHaveBeenCalledOnce();
  });

  it('keeps a maximum-size repeatedly interrupted plan within the export bounds', async () => {
    const test = setup({ models: 16, repeats: 5, diagnostics: 'placement', mode: 'both' });
    test.generate.mockImplementation(async () => {
      expect(test.runner.interruptCurrent({ trialId: runningId({ test }) })).toBe(true);
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    await test.start();
    const result = snapshotSchema.parse(test.runner.snapshot());
    expect(result.trials).toHaveLength(704);
    expect(new Set(result.trials.map(trial => trial.stepId)).size).toBe(704);
    expect(result.trials.every(trial => trial.status === 'interrupted' || trial.skipReason === 'dependency-interrupted')).toBe(true);
    expect(result.execution!.intervals.length).toBeGreaterThan(2048);
    expect(result.execution!.intervals.length).toBeLessThan(8192);
  });
});
