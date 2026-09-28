// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createBenchmarkRunner } from './runner';
import { planFixture, metricFixture } from './test-fixtures';
import { benchmarkManifest } from './archive';
import type { ImageClient } from '@/features/stable-diffusion-cpp-browser/worker/types';
import type { Request, WorkerResult } from '@/features/stable-diffusion-cpp-browser/types';
const runners: ReturnType<typeof createBenchmarkRunner>[] = [];
afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose(); vi.useRealTimers();
});
function harness({ behavior }: { behavior: (({ request, ordinal }: { request: Request, ordinal: number }) => Promise<WorkerResult>) | undefined }) {
  const clients: { calls: number, dispose: ReturnType<typeof vi.fn> }[] = [], requests: Request[] = [];
  const callbacks: Parameters<ImageClient['generate']>[0][] = [];
  let activeCount = 0, maxActive = 0;
  const publish = vi.fn(), stopVisibility = vi.fn();
  const createClient = vi.fn((): ImageClient => {
    activeCount++; maxActive = Math.max(activeCount, maxActive);
    const client = { calls: 0, dispose: vi.fn() }; let disposed = false;
    client.dispose.mockImplementation(() => {
      if (!disposed) {
        disposed = true; activeCount--;
      }
    }); clients.push(client);
    return { release: vi.fn(), dispose: client.dispose, cancel: vi.fn(), updatePreview: vi.fn(),
      async generate(args) {
        const reused = client.calls++ > 0; requests.push(args.request); callbacks.push(args);
        args.onDiagnostic?.({ diagnostic: metricFixture({ metric: 'worker-selection', fields: { reusedWorker: reused, reason: reused ? 'compatible' : 'first-request' } }) });
        args.onDiagnostic?.({ diagnostic: metricFixture({ metric: 'run-wall', fields: { milliseconds: 50, sampling: 40, 'model-load': reused ? 0 : 10 } }) });
        args.onProgress({ event: { phase: 'sampling', step: 1, steps: args.request.parameters.steps } });
        if (behavior) return behavior({ request: args.request, ordinal: requests.length });
        return { png: new Blob(['png'], { type: 'image/png' }), width: args.request.parameters.width, height: args.request.parameters.height, modelVersion: 'fixture', uniformOutput: false };
      },
    };
  });
  const observeVisibility = vi.fn<Parameters<typeof createBenchmarkRunner>[0]['observeVisibility']>(({ changed }) => {
    changed({ hidden: false }); return stopVisibility;
  });
  const runner = createBenchmarkRunner({ createClient, now: () => performance.now(), date: () => new Date().toISOString(), observeVisibility, publish }); runners.push(runner);
  return { runner, clients, requests, callbacks, createClient, publish, observeVisibility, stopVisibility, maxActive: () => maxActive, activeCount: () => activeCount };
}
it.each([
  { states: [false], hiddenObserved: false, visibilityChanges: 0 },
  { states: [true], hiddenObserved: true, visibilityChanges: 0 },
  { states: [false, true, false], hiddenObserved: true, visibilityChanges: 2 },
  { states: [false, false, true, true, false], hiddenObserved: true, visibilityChanges: 2 },
  { states: [true, false], hiddenObserved: true, visibilityChanges: 1 },
])('records visibility transitions separately from the initial state: $states', async ({ states, hiddenObserved, visibilityChanges }) => {
  const h = harness({ behavior: undefined });
  h.observeVisibility.mockImplementation(({ changed }) => {
    for (const hidden of states) changed({ hidden });
    return h.stopVisibility;
  });
  await h.runner.start({ plan: planFixture({ mode: 'fresh-each', repeats: 1 }) });
  const snapshot = h.runner.snapshot()!;
  for (const run of snapshot.runs) expect(run.record).toMatchObject({ hiddenObserved, visibilityChanges });
  const manifest = benchmarkManifest({ snapshot, includePrompts: false, includeInputImages: 'omit', exportedAt: new Date().toISOString() });
  for (const run of manifest.runs) expect(run).toMatchObject({ hiddenObserved, visibilityChanges });
});
it('uses one fresh context then two warm runs per model; disposes before the next model', async () => {
  const h = harness({ behavior: undefined }); await h.runner.start({ plan: planFixture({ mode: 'cold-warm', repeats: 3 }) });
  expect(h.clients.map(c => c.calls)).toEqual([3,3]); expect(h.maxActive()).toBe(1); expect(h.activeCount()).toBe(0);
  expect(h.clients.every(c => c.dispose.mock.calls.length === 1)).toBe(true);
  const rows = h.runner.snapshot()!.runs.map(run => run.record);
  expect(rows.map(r => r.metrics.reuse?.reusedWorker)).toEqual([false,true,true,false,true,true]);
  expect(rows.map(r => r.plannedKind)).toEqual(['cold','warm','warm','cold','warm','warm']);
  expect(rows.every(r => r.status === 'succeeded')).toBe(true); expect(h.stopVisibility).toHaveBeenCalledTimes(6);
  expect(h.requests.every(r => r.debug === 'on')).toBe(true);
});
it('fresh-each never reuses a client and preserves every run in the same model group', async () => {
  const h = harness({ behavior: undefined }); await h.runner.start({ plan: planFixture({ mode: 'fresh-each', repeats: 2 }) });
  expect(h.createClient).toHaveBeenCalledTimes(4); expect(h.clients.every(c => c.calls === 1)).toBe(true);
  expect(h.runner.snapshot()!.runs.map(r => r.record.modelIndex)).toEqual([0,0,1,1]);
});
it('does not retry or relabel cold after a failure; skips warm runs and continues the next model', async () => {
  const h = harness({ behavior: async ({ request, ordinal }) => {
    if (ordinal === 1) throw new WebAssembly.RuntimeError('memory access out of bounds');
    return { png: new Blob(['png'], { type: 'image/png' }), width: request.parameters.width, height: request.parameters.height, modelVersion: 'fixture', uniformOutput: false };
  } });
  await h.runner.start({ plan: planFixture({ mode: 'cold-warm', repeats: 3 }) });
  expect(h.runner.snapshot()!.runs.map(r => r.record.status)).toEqual(['failed','skipped','skipped','succeeded','succeeded','succeeded']);
  expect(h.requests).toHaveLength(4); expect(h.createClient).toHaveBeenCalledTimes(2);
});
it('can stop a noncooperating pending call, settles the queue, and preserves partial diagnostics', async () => {
  const h = harness({ behavior: async () => new Promise(() => undefined) });
  const task = h.runner.start({ plan: planFixture({ mode: 'cold-warm', repeats: 3 }) });
  await vi.waitFor(() => expect(h.requests).toHaveLength(1)); h.runner.stop(); await task;
  const snapshot = h.runner.snapshot()!;
  expect(snapshot.state).toBe('cancelled'); expect(snapshot.runs.map(r => r.record.status)).toEqual(['cancelled','skipped','skipped','skipped','skipped','skipped']);
  expect(snapshot.runs[0]!.diagnostics).toContain('run-wall'); expect(h.activeCount()).toBe(0);
});
it('does not attribute delayed callbacks to a later model or later batch', async () => {
  const h = harness({ behavior: undefined }); await h.runner.start({ plan: planFixture({ mode: 'fresh-each', repeats: 1 }) });
  const old = h.callbacks[0]!;
  h.publish.mockImplementation(() => {
    old.onDiagnostic?.({ diagnostic: metricFixture({ metric: 'run-wall', fields: { sampling: 999999 } }) });
  });
  await h.runner.start({ plan: planFixture({ mode: 'fresh-each', repeats: 1 }) });
  expect(h.runner.snapshot()!.runs.map(r => r.record.metrics.runWall?.sampling)).toEqual([40,40]);
});
it('disposes safely on page teardown even while a call ignores AbortSignal', async () => {
  const h = harness({ behavior: async () => new Promise(() => undefined) });
  const task = h.runner.start({ plan: planFixture({ mode: 'cold-warm', repeats: 1 }) });
  await vi.waitFor(() => expect(h.requests).toHaveLength(1)); h.runner.dispose(); await task;
  expect(h.activeCount()).toBe(0); expect(h.runner.snapshot()).toBeUndefined();
});
it('a synchronous Stop from the running notification does not launch a generation or leave a rejected Promise', async () => {
  const h = harness({ behavior: undefined });
  h.publish.mockImplementation(({ current }) => {
    if (current) h.runner.stop();
  });
  await h.runner.start({ plan: planFixture({ mode: 'cold-warm', repeats: 1 }) });
  expect(h.requests).toHaveLength(0); expect(h.activeCount()).toBe(0);
});
it('timeout retires the bad model and skips its warm runs; no timer leaks remain', async () => {
  vi.useFakeTimers(); const h = harness({ behavior: async ({ request, ordinal }) => ordinal === 1 ? new Promise(() => undefined) : {
    png: new Blob(['png'], { type: 'image/png' }), width: request.parameters.width, height: request.parameters.height, modelVersion: 'fixture', uniformOutput: false,
  } });
  const plan = planFixture({ mode: 'cold-warm', repeats: 2 }); plan.protocol.timeoutSeconds = 1;
  const task = h.runner.start({ plan }); await vi.advanceTimersByTimeAsync(1001); await task;
  expect(h.runner.snapshot()!.runs.map(r => r.record.status)).toEqual(['failed','skipped','succeeded','succeeded']);
  expect(h.runner.snapshot()!.runs[0]!.record.error).toContain('timed out'); expect(vi.getTimerCount()).toBe(0);
});
it('stopping during the cooldown starts no Worker', async () => {
  vi.useFakeTimers(); const h = harness({ behavior: undefined }); const plan = planFixture({ mode: 'cold-warm', repeats: 1 }); plan.protocol.cooldownSeconds = 60;
  const task = h.runner.start({ plan }); h.runner.stop(); await task;
  expect(h.createClient).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('keeps uniform outputs as successful evidence and bounds retained PNG bytes without rerunning', async () => {
  const image = new Blob([new Uint8Array(30 * 1024 ** 2)], { type: 'image/png' });
  const h = harness({ behavior: async ({ request }) => ({ png: image, width: request.parameters.width, height: request.parameters.height, modelVersion: 'fixture', uniformOutput: true }) });
  const plan = planFixture({ mode: 'cold-warm', repeats: 3 }); plan.protocol.keepImages = true;
  await h.runner.start({ plan }); const rows = h.runner.snapshot()!.runs;
  expect(h.requests).toHaveLength(6); expect(rows.filter(r => r.png)).toHaveLength(4);
  expect(rows.slice(4).every(r => r.record.image.status === 'budget-exceeded' && r.record.uniformOutput && r.record.status === 'succeeded')).toBe(true);
});
