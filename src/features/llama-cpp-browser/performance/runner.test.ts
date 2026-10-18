// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlamaCppBrowserService, LlamaCppPerformanceScope } from '@/features/llama-cpp-browser/service-contract';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { performanceEnvironment, performancePlan, performanceReport } from '@/features/llama-cpp-browser/test-utils/performance.test-support';
import { createPerformanceRunner } from './runner';
import { planSchema, snapshotSchema, type MeasurementMode } from './types';
import { summarizePerformance } from './summary';

function setup({ models = 1, diagnostics = 'none', mode }: { models?: number, diagnostics?: 'none' | 'placement', mode?: MeasurementMode } = {}) {
  const plan = performancePlan({ models, diagnostics, mode });
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
  const runner = createPerformanceRunner({
    service,
    now: () => clock,
    date: () => plan.createdAt,
    hidden: () => hidden,
    waitUntilVisible,
    publish: vi.fn(),
  });
  return {
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
