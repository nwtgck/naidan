import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlamaCppBrowserService } from './service-contract';
import type { MemoryDiagnostics } from './performance/memory-schema';

const harness = vi.hoisted(() => ({
  mode: 'hosted' as 'hosted' | 'standalone',
  events: [] as string[],
  workers: [] as RetirementWorker[],
  factoryGate: undefined as Promise<Worker> | undefined,
  generationGate: undefined as Promise<unknown> | undefined,
  fail: false,
  transportGate: undefined as Promise<void> | undefined,
}));
vi.mock('@/features/llama-cpp-browser/worker/client', async () => {
  const hosted = await import('./worker/client-hosted');
  const standalone = await import('./worker/client-standalone');
  return { createLlamaCppWorkerClient: () => (harness.mode === 'hosted' ? hosted : standalone).createLlamaCppWorkerClient() };
});
vi.mock('virtual:file-protocol-standalone/worker/llama-cpp-browser', () => ({
  createStandaloneWorker: () => harness.factoryGate ?? Promise.resolve(new RetirementWorker() as unknown as Worker),
}));
vi.mock('./runtime/shared-storage-probe', () => ({ verifySharedStorage: async () => {} }));
vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  wrapWorkerRemote: ({ endpoint }: { endpoint: RetirementWorker }) => endpoint.remote,
  releaseWorkerRemote: () => harness.transportGate,
  workerProxy: ({ value }: { value: unknown }) => value,
}));
class RetirementWorker extends EventTarget {
  id = harness.workers.length;
  lateDiagnostic: ((value: { diagnostic: unknown }) => void) | undefined;
  postMessage = vi.fn();
  terminate = vi.fn(() => {
    harness.events.push(`terminate:${this.id}`);
  });
  remote = {
    probeProfiles: async () => {
      harness.events.push(`init:${this.id}`);
      return { recommended: 'webgpu-wasm64-jspi', profiles: [{ profile: 'webgpu-wasm64-jspi', status: 'available' }] };
    },
    release: async () => {
      harness.events.push(`release:${this.id}`);
    },
    cancelGeneration: async () => {},
    generate: async (request: { measurement?: { sequence: string } }, _event: unknown, _progress: unknown, diagnostic: (value: { diagnostic: unknown }) => void) => {
      harness.events.push(`generate:${this.id}:${request.measurement?.sequence ?? 'chat'}`);
      this.lateDiagnostic = diagnostic;
      diagnostic({ diagnostic: { event: 'native-info', nativeMetric: 'model_buffer_mib', nativeBackend: 'CPU', nativeValue: 12 } });
      if (harness.fail) throw new Error('load failed');
      if (harness.generationGate) await harness.generationGate;
      return { content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' };
    },
  };
  constructor() {
    super(); harness.workers.push(this); harness.events.push(`create:${this.id}`);
  }
}
let service: LlamaCppBrowserService;
function input() {
  return { model: 'local.gguf', messages: [{ role: 'user' as const, content: 'hello' }], temperature: 0, topP: 1, maxTokens: 3, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
}
const snapshots: MemoryDiagnostics[] = [];
function measure({ signal, warm = false }: { signal?: AbortSignal, warm?: boolean } = {}) {
  return service.runPerformanceOperation({
    options: { profile: 'webgpu-wasm64-jspi' },
    signal,
    operation: async ({ scope }) => {
      for (const sequence of warm ? ['fresh', 'continue'] as const : ['fresh'] as const) {
        await scope.generate({
          input: input(),
          sequence,
          signal: scope.signal,
          onEvent: () => {},
          onSummary: () => {},
          onMemoryDiagnostics: ({ memory }) => {
            harness.events.push(`snapshot:${harness.workers.at(-1)?.id}`); snapshots.push(memory);
          },
        });
      }
    },
  });
}

beforeEach(async () => {
  vi.resetModules(); harness.events.length = 0; harness.workers.length = 0; snapshots.length = 0;
  harness.factoryGate = undefined; harness.generationGate = undefined; harness.transportGate = undefined; harness.fail = false;
  vi.stubGlobal('Worker', RetirementWorker);
  service = (await import('./index-hosted')).llamaCppBrowserService;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  service.release(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

for (const mode of ['hosted', 'standalone'] as const) describe(`${mode} actual client retirement`, () => {
  beforeEach(() => {
    harness.mode = mode;
  });

  it('ends each model before next init, preserves snapshot, and keeps warm continuation in one worker', async () => {
    await measure({ warm: true });
    expect(harness.workers).toHaveLength(1);
    expect(harness.events.indexOf('snapshot:0')).toBeLessThan(harness.events.indexOf('terminate:0'));
    const snapshot = structuredClone(snapshots[0]);
    await measure(); await measure();
    for (const id of [0, 1]) expect(harness.events.indexOf(`terminate:${id}`)).toBeLessThan(harness.events.indexOf(`create:${id + 1}`));
    harness.workers[0]!.lateDiagnostic?.({ diagnostic: { event: 'native-info', nativeMetric: 'model_buffer_mib', nativeBackend: 'CPU', nativeValue: 999 } });
    expect(snapshots[0]).toEqual(snapshot);
    expect(harness.events).toContain('generate:0:continue');
    expect(snapshots.every(value => value.nativeAllocations.length === 1)).toBe(true);
  });

  it('retires failed load before next model and retains received diagnostics', async () => {
    harness.fail = true;
    await expect(measure()).rejects.toThrow();
    expect(snapshots[0]?.nativeAllocations[0]?.nativeValue).toBe(12);
    harness.fail = false; await measure();
    expect(harness.events.indexOf('terminate:0')).toBeLessThan(harness.events.indexOf('create:1'));
  });

  it('retires on user cancellation after the bounded unresponsive-generation timeout', async () => {
    vi.useFakeTimers(); harness.generationGate = new Promise(() => {});
    const controller = new AbortController(); const measured = measure({ signal: controller.signal });
    const rejected = expect(measured).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(harness.events).toContain('generate:0:fresh'));
    controller.abort(); await vi.advanceTimersByTimeAsync(9000); await rejected;
    expect(harness.workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(snapshots[0]?.nativeAllocations[0]?.nativeValue).toBe(12);
    harness.generationGate = undefined; await measure();
    expect(harness.events.indexOf('terminate:0')).toBeLessThan(harness.events.indexOf('create:1'));
  });

  it('rejects a measurement while unrelated chat owns the worker without terminating it', async () => {
    const gate = Promise.withResolvers<void>(); harness.generationGate = gate.promise;
    const chat = service.generate({ input: input(), onEvent: () => {}, signal: undefined });
    await vi.waitFor(() => expect(harness.events).toContain('generate:0:chat'));
    await expect(measure()).rejects.toThrow('busy');
    expect(harness.workers[0]!.terminate).not.toHaveBeenCalled();
    gate.resolve(); await chat;
  });
});

it('awaits delayed standalone factory and its teardown before allowing the next model', async () => {
  harness.mode = 'standalone';
  const gate = Promise.withResolvers<Worker>(); harness.factoryGate = gate.promise;
  const controller = new AbortController(); const measured = measure({ signal: controller.signal });
  const rejected = expect(measured).rejects.toThrow('aborted');
  await vi.waitFor(() => expect(service.getProfileState().status).toBe('checking'));
  controller.abort();
  let settled = false; void measured.catch(() => {}).then(() => {
    settled = true;
  });
  await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
  const old = new RetirementWorker(); gate.resolve(old as unknown as Worker);
  await rejected; expect(old.terminate).toHaveBeenCalledOnce();
  harness.factoryGate = undefined; await measure();
  expect(harness.events.indexOf('terminate:0')).toBeLessThan(harness.events.indexOf('create:1'));
});

it('waits for standalone transport cleanup completion rather than just calling dispose', async () => {
  harness.mode = 'standalone';
  const gate = Promise.withResolvers<void>(); harness.transportGate = gate.promise;
  const measured = measure();
  await vi.waitFor(() => expect(harness.events).toContain('snapshot:0'));
  expect(harness.workers[0]!.terminate).not.toHaveBeenCalled();
  await expect(measure()).rejects.toThrow('busy');
  gate.resolve(); await measured;
  harness.transportGate = undefined; await measure();
  expect(harness.events.indexOf('terminate:0')).toBeLessThan(harness.events.indexOf('create:1'));
});

it('does not lose unfinished retirement when ordinary release clears the shared client', async () => {
  harness.mode = 'standalone';
  await service.generate({ input: input(), onEvent: () => {}, signal: undefined });
  const gate = Promise.withResolvers<void>(); harness.transportGate = gate.promise;
  service.release();
  const measured = measure();
  await new Promise(resolve => setTimeout(resolve, 30));
  const createdBeforeOldTermination = harness.workers.length;
  gate.resolve(); await measured;
  expect(createdBeforeOldTermination).toBe(1);
  expect(harness.events.indexOf('terminate:0')).toBeLessThan(harness.events.indexOf('create:1'));
});

it('direct standalone disposal awaits a late factory without ever initializing its remote', async () => {
  const { createLlamaCppWorkerClient } = await import('./worker/client-standalone');
  const gate = Promise.withResolvers<Worker>(); harness.factoryGate = gate.promise;
  const client = createLlamaCppWorkerClient();
  const operation = client.probeProfiles({ signal: undefined });
  const rejected = expect(operation).rejects.toThrow('worker-failed');
  const disposal = client.dispose(); await rejected;
  let settled = false; void Promise.resolve(disposal).then(() => {
    settled = true;
  });
  await Promise.resolve(); expect(settled).toBe(false);
  const old = new RetirementWorker(); gate.resolve(old as unknown as Worker);
  await disposal;
  expect(old.terminate).toHaveBeenCalledOnce();
  expect(harness.events).not.toContain('init:0');
});

it('ignores old callbacks while the next model collector is actively recording', async () => {
  harness.mode = 'hosted'; await measure();
  const gate = Promise.withResolvers<void>(); harness.generationGate = gate.promise;
  const measured = measure();
  await vi.waitFor(() => expect(harness.events).toContain('generate:1:fresh'));
  harness.workers[0]!.lateDiagnostic?.({ diagnostic: { event: 'native-info', nativeMetric: 'model_buffer_mib', nativeBackend: 'CPU', nativeValue: 999 } });
  gate.resolve(); await measured;
  expect(snapshots.map(value => value.nativeAllocations.map(item => item.nativeValue))).toEqual([[12], [12]]);
});
