import { describe, expect, it, vi } from 'vitest';
import { gpuProfileSchema } from '@/features/llama-cpp-browser/performance/gpu-profile-schema';
import { createGpuProfileFixture, createMeasurementFixture } from './gpu-profiler.test-support';

type Fixture = ReturnType<typeof createGpuProfileFixture>;

function timestampBuffer({ gpu, offset = 0 }: { gpu: Fixture, offset?: number }): GPUBuffer {
  const querySet = gpu.query();
  gpu.pass({ querySet }).end();
  const source = gpu.resolve({ querySet });
  const target = gpu.hostBuffer({ size: offset + 32 });
  gpu.encoder.copyBufferToBuffer(source, 0, target, offset, 16);
  return target;
}

describe('existing timestamp-buffer map wait observations', () => {
  it('returns the original Promise, preserves buffer identity, and times only existing work', async () => {
    using scope = createMeasurementFixture();
    let time = 10;
    const now = vi.fn(() => time);
    using gpu = createGpuProfileFixture({ now });
    scope.enter({ phase: 'prefill' });
    const target = timestampBuffer({ gpu });
    scope.enter({ phase: 'decode' });
    const pending = Promise.withResolvers<void>();
    gpu.setMapResult({ run: () => pending.promise });
    const promise = target.mapAsync(1);
    expect(promise).toBe(pending.promise);
    expect(target).toBe(gpu.rawBuffers.at(-1));
    scope.enter({ phase: 'checkpoint' });
    time = 35;
    pending.resolve();
    await promise;
    target.getMappedRange();
    const result = scope.finish();
    expect(result.status).toBe('complete');
    expect(result.totalGpuMs).toBe(2);
    expect(result.rows[0]?.phase).toBe('prefill');
    expect(result.readbacks).toEqual({ source: 'existing-timestamp-buffer-mapAsync', phaseAt: 'map-request', rows: [{ phase: 'decode', requested: 1, completed: 1, rejected: 0, pending: 0, invalidTimings: 0, totalWaitMs: 25, maximumWaitMs: 25 }] });
    expect(now).toHaveBeenCalledTimes(2);
    expect(gpu.calls).toEqual({ buffers: 2, passes: 1, dispatches: 1, resolves: 1, copies: 1, maps: 1, reads: 1, submits: 0 });
  });

  it('does not read the clock for unrelated, consumed, or out-of-range timestamp data', async () => {
    using scope = createMeasurementFixture();
    const now = vi.fn(() => 0);
    using gpu = createGpuProfileFixture({ now });
    await gpu.hostBuffer().mapAsync(1);
    const target = timestampBuffer({ gpu, offset: 16 });
    await target.mapAsync(1, 0, 16);
    target.getMappedRange(16, 16);
    await target.mapAsync(1, 16, 16);
    expect(now).not.toHaveBeenCalled();
    expect(scope.finish().readbacks?.rows).toEqual([]);
  });

  it('does not read the clock outside a measurement, even for old pending metadata', async () => {
    const now = vi.fn(() => 0);
    using gpu = createGpuProfileFixture({ now });
    await gpu.hostBuffer().mapAsync(1);
    using scope = createMeasurementFixture();
    const target = timestampBuffer({ gpu });
    scope.finish();
    await target.mapAsync(1);
    expect(now).not.toHaveBeenCalled();
  });

  it('captures pending waits without letting their late completion mutate either measurement', async () => {
    using scope = createMeasurementFixture();
    const now = vi.fn(() => 10);
    using gpu = createGpuProfileFixture({ now });
    const target = timestampBuffer({ gpu });
    const pending = Promise.withResolvers<void>();
    gpu.setMapResult({ run: () => pending.promise });
    const promise = target.mapAsync(1);
    const result = scope.finish();
    expect(result.readbacks?.rows[0]).toMatchObject({ requested: 1, completed: 0, pending: 1 });
    using next = createMeasurementFixture();
    pending.resolve();
    await promise;
    target.getMappedRange();
    expect(result.readbacks?.rows[0]).toMatchObject({ completed: 0, pending: 1 });
    expect(next.finish().readbacks?.rows).toEqual([]);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('preserves the original rejection and observes its existing wait', async () => {
    using scope = createMeasurementFixture();
    let time = 5;
    using gpu = createGpuProfileFixture({ now: () => time });
    const target = timestampBuffer({ gpu });
    const pending = Promise.withResolvers<void>();
    const failure = new Error('native map rejected');
    gpu.setMapResult({ run: () => pending.promise });
    const promise = target.mapAsync(1);
    const assertion = expect(promise).rejects.toBe(failure);
    time = 14;
    pending.reject(failure);
    await assertion;
    expect(scope.finish().readbacks?.rows[0]).toMatchObject({ requested: 1, completed: 0, rejected: 1, pending: 0, totalWaitMs: 9 });
  });

  it('preserves synchronous native failures without starting another map', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture({ now: () => 1 });
    const target = timestampBuffer({ gpu });
    const failure = new Error('native map throws');
    gpu.setMapResult({
      run() {
        throw failure;
      },
    });
    expect(() => target.mapAsync(1)).toThrow(failure);
    expect(gpu.calls.maps).toBe(1);
    expect(scope.finish().readbacks?.rows[0]).toMatchObject({ completed: 0, rejected: 1, pending: 0, totalWaitMs: 0 });
  });

  it.each([
    [NaN, 1], [1, Infinity], [10, 9], [-1, 2], [1, -2],
  ])('records invalid clock values %s -> %s without corrupting inference or timestamp totals', async (start, end) => {
    using scope = createMeasurementFixture();
    let time = start;
    using gpu = createGpuProfileFixture({ now: () => time });
    const target = timestampBuffer({ gpu });
    const pending = Promise.withResolvers<void>();
    gpu.setMapResult({ run: () => pending.promise });
    const promise = target.mapAsync(1);
    time = end;
    pending.resolve();
    await promise;
    target.getMappedRange();
    const result = scope.finish();
    expect(result).toMatchObject({ status: 'partial', measuredPasses: 1, totalGpuMs: 2 });
    expect(result.readbacks?.rows[0]).toMatchObject({ completed: 1, pending: 0, invalidTimings: 1, totalWaitMs: 0, maximumWaitMs: 0 });
  });

  it('contains a throwing clock and retains a valid schema', async () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture({
      now() {
        throw new Error('clock');
      },
    });
    const target = timestampBuffer({ gpu });
    await target.mapAsync(1);
    target.getMappedRange();
    const result = scope.finish();
    expect(result.readbacks?.rows[0]?.invalidTimings).toBe(1);
    expect(gpuProfileSchema.parse(result)).toEqual(result);
  });

  it('aggregates repeated waits by request phase without summing them into GPU time', async () => {
    using scope = createMeasurementFixture();
    let time = 0;
    using gpu = createGpuProfileFixture({ now: () => time++ });
    for (const phase of ['prefill', 'decode', 'decode', 'checkpoint', 'other'] as const) {
      scope.enter({ phase });
      const target = timestampBuffer({ gpu });
      await target.mapAsync(1);
      target.getMappedRange();
    }
    const result = scope.finish();
    expect(result.readbacks?.rows).toHaveLength(4);
    expect(result.readbacks?.rows.find(row => row.phase === 'decode')).toMatchObject({ requested: 2, completed: 2, totalWaitMs: 2, maximumWaitMs: 1 });
    expect(result.totalGpuMs).toBe(10);
  });

  it('deduplicates an owner when several timestamps are mapped in one request', async () => {
    using scope = createMeasurementFixture();
    const now = vi.fn(() => 1);
    using gpu = createGpuProfileFixture({ now });
    const target = timestampBuffer({ gpu });
    await target.mapAsync(1);
    expect(scope.finish().readbacks?.rows[0]?.requested).toBe(1);
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('retains existing timestamp collection when the optional map hook cannot be installed', async () => {
    using scope = createMeasurementFixture();
    const now = vi.fn(() => 1);
    using gpu = createGpuProfileFixture({ now });
    gpu.freezeMapMethods();
    const target = timestampBuffer({ gpu });
    await target.mapAsync(1);
    target.getMappedRange();
    const result = scope.finish();
    expect(result).toMatchObject({ status: 'partial', measuredPasses: 1, totalGpuMs: 2, instrumentationErrors: 1 });
    expect(result.readbacks?.rows).toEqual([]);
    expect(now).not.toHaveBeenCalled();
    expect(gpu.calls.maps).toBe(1);
  });

  it('still accepts version-one archives without readback observations', () => {
    using scope = createMeasurementFixture();
    const result = scope.finish();
    const { readbacks: _readbacks, ...old } = result;
    expect(gpuProfileSchema.parse(old)).toEqual(old);
  });
});
