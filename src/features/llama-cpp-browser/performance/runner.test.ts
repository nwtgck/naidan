// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlamaCppBrowserService, LlamaCppPerformanceScope } from '@/features/llama-cpp-browser/service-contract';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { performanceEnvironment, performancePlan, performanceReport } from '@/features/llama-cpp-browser/test-utils/performance';
import { createPerformanceRunner } from './runner';
import { snapshotSchema } from './types';
import { summarizePerformance } from './summary';

function setup({ models = 1, diagnostics = 'none' }: { models?: number, diagnostics?: 'none' | 'placement' } = {}) {
  const plan = performancePlan({ models, diagnostics });
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
      try {
        await operation({ scope: { options, signal: signal ?? new AbortController().signal, generate } });
      } finally {
        order.push('release');
      }
    }),
  };
  const waitUntilVisible = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
    signal.throwIfAborted(); hidden = false;
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
      hidden = true; runner.visibilityChanged();
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
    for (const [index, [call]] of test.generate.mock.calls.entries()) expect(call.input).toMatchObject({ temperature: 0, topP: 1, debug: 'off', maxTokens: test.plan.steps[index]!.maxTokens });
    expect(summarizePerformance({ snapshot })).toHaveLength(10);
  });

  it('rejects changed model inventory without beginning that model', async () => {
    const test = setup(); test.service.listModels.mockResolvedValue([{ ...test.plan.models[0]!, importedAt: 2 }]);
    await test.start();
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.runner.snapshot()?.trials.every(trial => trial.status === 'skipped')).toBe(true);
    expect(test.runner.snapshot()?.modelErrors[0]?.error).toContain('inventory changed');
  });

  it('records a model failure, retires that model, and continues with the next model', async () => {
    const test = setup({ models: 2 }); test.generate.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'runtime-error' }));
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
    vi.useFakeTimers(); const test = setup();
    test.generate.mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new LlamaCppBrowserError({ code: 'aborted' })), { once: true });
    }));
    const pending = test.start();
    await vi.advanceTimersByTimeAsync(1001); await pending;
    expect(test.runner.snapshot()?.trials[0]).toMatchObject({ status: 'failed', error: 'trial-timeout' });
    expect(test.generate).toHaveBeenCalledOnce();
  });

  it('excludes hidden trials without replacing a slow measurement or hiding raw evidence', async () => {
    const test = setup(); const original = test.generate.getMockImplementation()!;
    test.generate.mockImplementationOnce(async args => {
      test.hide(); return original(args);
    });
    await test.start();
    expect(test.runner.snapshot()?.trials).toHaveLength(5);
    expect(test.runner.snapshot()?.trials[0]?.exclusion).toContain('page-hidden');
    expect(summarizePerformance({ snapshot: test.runner.snapshot()! }).some(group => group.scenario === 'initial')).toBe(false);
    expect(test.waitUntilVisible).toHaveBeenCalledTimes(6);
  });

  it('does not fabricate a continuation after an empty preparation', async () => {
    const test = setup(); const original = test.generate.getMockImplementation()!; let calls = 0;
    test.generate.mockImplementation(async args => {
      const result = await original(args); calls++;
      return calls === 2 ? { ...result, content: '', reasoningContent: '' } : result;
    });
    await test.start();
    expect(test.generate).toHaveBeenCalledTimes(4);
    expect(test.runner.snapshot()?.trials[2]?.status).toBe('skipped');
  });

  it('separates truncated-parent continuations while excluding unexpected fresh reuse', async () => {
    const test = setup(); const original = test.generate.getMockImplementation()!;
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
    const test = setup(); test.generate.mockResolvedValue({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    await test.start();
    expect(test.runner.snapshot()?.trials[0]?.exclusion).toContain('missing-summary');
    expect(test.runner.snapshot()?.trials[0]?.exclusion).not.toContain('unexpected-reuse');
    expect(test.runner.snapshot()?.trials[0]?.firstReceivedMs).toBeUndefined();
  });

  it('rejects overlapping starts', async () => {
    const test = setup(); const gate = Promise.withResolvers<void>();
    test.waitUntilVisible.mockImplementationOnce(async () => gate.promise);
    const first = test.start(); await expect(test.start()).rejects.toThrow('already running');
    test.runner.stop(); gate.resolve(); await first;
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
      try {
        await operation({ scope: { options, signal: owner.signal, generate: test.generate } });
      } finally {
        owner.abort();
      }
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
  const test = setup({ diagnostics: 'placement' }); await test.start();
  expect(test.generate).toHaveBeenCalledTimes(6);
  expect(test.generate.mock.calls.map(([call]) => call.observation)).toEqual([undefined, undefined, undefined, undefined, undefined, 'placement']);
  const snapshot = test.runner.snapshot()!;
  expect(snapshot.trials.at(-1)?.exclusion).toEqual(['instrumented']);
  expect(snapshot.trials.at(-1)?.warnings).toEqual(['placement-missing']);
  expect(summarizePerformance({ snapshot }).map(group => group.scenario)).not.toContain('placement');
});

describe('orchestration timing, separate from inference', () => {
  it('records hidden waits between trials rather than charging them to GPU time', async () => {
    const test = setup(); let calls = 0;
    test.waitUntilVisible.mockImplementation(async ({ signal }) => {
      signal.throwIfAborted();
      if (++calls === 3) {
        test.hide(); test.advance(13000);
      }
      if (calls === 6) {
        test.hide(); test.advance(61000);
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
      for (let index = 0; index < 300; index++) test.hide();
      test.advance(7000); test.runner.stop(); signal.throwIfAborted();
    });
    await test.start();
    const snapshot = snapshotSchema.parse(test.runner.snapshot());
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.execution).toMatchObject({ elapsedMs: 7000, droppedVisibilityEvents: 45 });
    expect(snapshot.execution?.visibility).toHaveLength(256);
    expect(snapshot.execution?.intervals).toContainEqual(expect.objectContaining({ kind: 'visibility-wait', elapsedMs: 7000, outcome: 'cancelled' }));
    expect(test.generate).not.toHaveBeenCalled();
    test.hide(); expect(snapshot.execution?.visibility).toHaveLength(256);
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
