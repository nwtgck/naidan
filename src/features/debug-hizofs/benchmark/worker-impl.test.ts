import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHizoFSBenchmarkPresetConfiguration } from '@/features/debug-hizofs/benchmark/presets';
import type { HizoFSBenchmarkRuntimePort } from '@/features/debug-hizofs/benchmark/runtime-port';
import { createHizoFSBenchmarkWorker } from '@/features/debug-hizofs/benchmark/worker-impl';

const runtimePort = {} as HizoFSBenchmarkRuntimePort;

const mocks = vi.hoisted(() => ({
  clean: vi.fn(async () => undefined),
  run: vi.fn(),
}));

vi.mock('@/features/debug-hizofs/benchmark/engine', () => ({
  cleanHizoFSBenchmarkData: mocks.clean,
  runHizoFSBenchmark: mocks.run,
}));

describe('HizoFS benchmark worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects invalid configuration before entering the benchmark engine', async () => {
    const worker = createHizoFSBenchmarkWorker({ runtimePort });

    await expect(worker.runBenchmark(
      { preset: 'invalid' } as never,
      () => undefined,
    )).rejects.toThrow();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('invalidates the active run when cancellation is requested', async () => {
    let assertActive: (() => void) | undefined;
    let rejectRun: ((reason: Error) => void) | undefined;
    mocks.run.mockImplementationOnce(async ({ assertActive: receivedAssertActive }) => {
      assertActive = receivedAssertActive;
      return await new Promise((_resolve, reject) => {
        rejectRun = reject;
      });
    });
    const worker = createHizoFSBenchmarkWorker({ runtimePort });
    const run = worker.runBenchmark(
      createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
      () => undefined,
    );
    await vi.waitFor(() => expect(assertActive).toBeTypeOf('function'));

    await worker.cancelCurrentOperation();
    expect(() => assertActive?.()).toThrowError(expect.objectContaining({ name: 'AbortError' }));
    rejectRun?.(new DOMException('cancelled', 'AbortError'));
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('forwards the injected runtime capability without exposing it through the worker API', async () => {
    let rejectRun: ((reason: Error) => void) | undefined;
    mocks.run.mockImplementationOnce(async () => await new Promise((_resolve, reject) => {
      rejectRun = reject;
    }));
    const worker = createHizoFSBenchmarkWorker({ runtimePort });

    const run = worker.runBenchmark(
      createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
      () => undefined,
    );
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled());

    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ runtimePort }));
    rejectRun?.(new Error('test completed'));
    await expect(run).rejects.toThrow('test completed');
  });

  it('delegates isolated benchmark cleanup', async () => {
    const worker = createHizoFSBenchmarkWorker({ runtimePort });
    await worker.cleanBenchmarkData();
    expect(mocks.clean).toHaveBeenCalledWith({ nativeOpfsRoot: undefined });
  });
});
