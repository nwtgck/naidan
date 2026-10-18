import { describe, expect, it } from 'vitest';
import { maximumGpuProfileGroups, maximumPendingGpuProfilePasses } from '@/features/llama-cpp-browser/performance/gpu-profile-schema';
import { createGpuProfileFixture, createMeasurementFixture } from './gpu-profiler.test-support';

describe('diagnostic-only public WebGPU timestamp observation', () => {
  it('reuses existing query readback without adding GPU work and keeps native receivers and buffer identity', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    scope.enter({ phase: 'decode' });
    const querySet = gpu.query();
    gpu.pass({ querySet }).end();
    const bytes = gpu.read({ querySet });
    expect(new DataView(bytes).getBigUint64(8, true)).toBe(3000000n);
    const result = scope.finish();
    expect(result).toMatchObject({ status: 'complete', observedPasses: 1, measuredPasses: 1, pendingPasses: 0, totalGpuMs: 2 });
    expect(result.rows).toEqual([{ phase: 'decode', shader: 'mul_mat_vec_q4_K_f32', workgroups: [8, 2, 1], passes: 1, dispatches: 1, multiDispatchPasses: 0, totalGpuMs: 2, meanPassMs: 2, minimumPassMs: 2, maximumPassMs: 2, zeroDurationPasses: 0 }]);
    expect(gpu.calls).toEqual({ buffers: 2, passes: 1, dispatches: 1, resolves: 1, copies: 1, maps: 0, reads: 1, submits: 0 });
    const weights = gpu.device.createBuffer({ size: 16, usage: 0x0080 });
    expect(weights).toBe(gpu.rawBuffers.at(-1));
    expect(scope.finish()).toBe(result);
  });

  it('attributes timestamps to the phase at encoding, never the later readback phase', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query();
    scope.enter({ phase: 'prefill' });
    gpu.pass({ querySet }).end();
    scope.enter({ phase: 'checkpoint' });
    gpu.read({ querySet });
    expect(scope.finish().rows[0]?.phase).toBe('prefill');
  });

  it('separates quantization, actual workgroup grids and phases without parsing shader names', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    for (const phase of ['prefill', 'decode'] as const) {
      for (const shader of ['mul_mat_vec_q4_K_f32', 'mul_mat_vec_q6_K_f32']) {
        scope.enter({ phase });
        const querySet = gpu.query();
        gpu.pass({ querySet, shader }).end();
        gpu.read({ querySet });
      }
    }
    expect(scope.finish().rows).toHaveLength(4);
    expect(scope.finish().totalGpuMs).toBe(8);
  });

  it('aggregates repeated shader passes with counts, minima and maxima', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    for (const end of [2000000n, 5000000n]) {
      const querySet = gpu.query({ values: [1000000n, end] });
      gpu.pass({ querySet }).end();
      gpu.read({ querySet });
    }
    expect(scope.finish().rows[0]).toMatchObject({ passes: 2, dispatches: 2, totalGpuMs: 5, meanPassMs: 2.5, minimumPassMs: 1, maximumPassMs: 4 });
  });

  it('observes real multi-dispatch passes without inventing per-dispatch latency or grids', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query();
    gpu.pass({ querySet, dispatches: 3 }).end();
    gpu.read({ querySet });
    expect(scope.finish().rows[0]).toMatchObject({ passes: 1, dispatches: 3, multiDispatchPasses: 1, workgroups: undefined, totalGpuMs: 2 });
  });

  it('labels mixed-pipeline passes as ambiguous, not as the last shader', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query();
    const pass = gpu.pass({ querySet });
    pass.setPipeline({ label: 'rms_norm' } as GPUComputePipeline);
    pass.dispatchWorkgroups(1);
    pass.end();
    gpu.read({ querySet });
    expect(scope.finish()).toMatchObject({ status: 'partial', ambiguousPasses: 1, rows: [{ shader: '[multiple-pipelines]', dispatches: 2 }] });
  });

  it('records indirect dispatches without claiming to know their grid', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query();
    const pass = gpu.pass({ querySet, dispatches: 0 });
    pass.dispatchWorkgroupsIndirect(gpu.hostBuffer(), 0);
    pass.end();
    gpu.read({ querySet });
    expect(scope.finish().rows[0]).toMatchObject({ dispatches: 1, workgroups: undefined });
  });

  it.each([0n, 100n])('preserves very short or quantized-zero measurements (%s ns)', ns => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query({ values: [1000n, 1000n + ns] });
    gpu.pass({ querySet }).end();
    gpu.read({ querySet });
    expect(scope.finish()).toMatchObject({ status: 'complete', totalGpuMs: Number(ns) / 1000000, zeroDurationPasses: Number(ns === 0n), precision: 'browser-defined' });
  });

  it.each([[5n, 4n], [0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]])('rejects reversed or imprecise timestamps %s', (start, end) => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query({ values: [start, end] });
    gpu.pass({ querySet }).end();
    gpu.read({ querySet });
    expect(scope.finish()).toMatchObject({ status: 'unavailable', invalidPasses: 1, measuredPasses: 0, pendingPasses: 0, rows: [] });
  });

  it('rejects empty passes rather than attributing their elapsed time to a kernel', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query();
    gpu.pass({ querySet, dispatches: 0 }).end();
    gpu.read({ querySet });
    expect(scope.finish()).toMatchObject({ invalidPasses: 1, rows: [] });
  });

  it('ignores untimestamped passes and reports unavailable instead of a false zero GPU duration', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    gpu.encoder.beginComputePass().end();
    expect(scope.finish()).toMatchObject({ status: 'unavailable', observedPasses: 0, rows: [] });
  });

  it('reports pending and malformed timestamp pairs explicitly', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query();
    gpu.pass({ querySet }).end();
    gpu.encoder.beginComputePass({ timestampWrites: { querySet, beginningOfPassWriteIndex: 2 } }).end();
    expect(scope.finish()).toMatchObject({ observedPasses: 2, pendingPasses: 1, invalidPasses: 1, status: 'unavailable' });
  });

  it('supports partial query resolves, buffer offsets, split copies and partial mapped ranges', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query({ values: [0n, 0n, 1000000n, 3000000n] });
    gpu.pass({ querySet, start: 2, end: 3 }).end();
    const source = gpu.resolve({ querySet, first: 2, count: 2 });
    const host = gpu.hostBuffer({ size: 64 });
    gpu.encoder.copyBufferToBuffer(source, 0, host, 16, 8);
    gpu.encoder.copyBufferToBuffer(source, 8, host, 40, 8);
    host.getMappedRange(40, 8);
    host.getMappedRange(16, 8);
    expect(scope.finish()).toMatchObject({ measuredPasses: 1, totalGpuMs: 2, pendingPasses: 0 });
  });

  it('supports the offset-free copy overload and implicit full-buffer size', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query();
    gpu.pass({ querySet }).end();
    const source = gpu.resolve({ querySet });
    const host = gpu.hostBuffer();
    gpu.encoder.copyBufferToBuffer(source, host);
    host.getMappedRange();
    expect(scope.finish().measuredPasses).toBe(1);
  });

  it('does not count repeated mapping of the same timestamps twice', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query();
    gpu.pass({ querySet }).end();
    const source = gpu.resolve({ querySet });
    const host = gpu.hostBuffer();
    gpu.encoder.copyBufferToBuffer(source, 0, host, 0, 16);
    host.getMappedRange();
    host.getMappedRange();
    expect(scope.finish().measuredPasses).toBe(1);
    expect(gpu.calls.reads).toBe(2);
  });

  it('invalidates metadata when a later non-timestamp copy overwrites the buffer', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query();
    gpu.pass({ querySet }).end();
    const source = gpu.resolve({ querySet });
    const host = gpu.hostBuffer();
    gpu.encoder.copyBufferToBuffer(source, 0, host, 0, 16);
    const other = gpu.device.createBuffer({ size: 16, usage: 4 });
    gpu.encoder.copyBufferToBuffer(other, 0, host, 0, 16);
    host.getMappedRange();
    expect(scope.finish()).toMatchObject({ measuredPasses: 0, pendingPasses: 1 });
  });

  it('never attributes late readback to the next request, including when query slots are reused', () => {
    using old = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    const querySet = gpu.query();
    gpu.pass({ querySet }).end();
    const oldSource = gpu.resolve({ querySet });
    const oldHost = gpu.hostBuffer();
    gpu.encoder.copyBufferToBuffer(oldSource, 0, oldHost, 0, 16);
    const oldResult = old.finish();
    using next = createMeasurementFixture();
    gpu.pass({ querySet }).end();
    oldHost.getMappedRange();
    gpu.read({ querySet });
    expect(old.finish()).toBe(oldResult);
    expect(oldResult.pendingPasses).toBe(1);
    expect(next.finish()).toMatchObject({ measuredPasses: 1, pendingPasses: 0, totalGpuMs: 2 });
  });

  it('contains observer failures while preserving native exceptions', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    gpu.freezeBuffers();
    expect(() => gpu.hostBuffer()).not.toThrow();
    gpu.failReads();
    expect(() => gpu.rawBuffers[0]!.getMappedRange()).toThrow(gpu.nativeFailure);
    expect(scope.finish().instrumentationErrors).toBe(1);
  });

  it('caps retained shader groups while still reporting total measured time and omissions', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    for (let i = 0; i <= maximumGpuProfileGroups; i++) {
      const querySet = gpu.query();
      gpu.pass({ querySet, shader: `shader-${i}` }).end();
      gpu.read({ querySet });
    }
    expect(scope.finish()).toMatchObject({ status: 'partial', measuredPasses: maximumGpuProfileGroups + 1, ungroupedPasses: 1, totalGpuMs: (maximumGpuProfileGroups + 1) * 2 });
    expect(scope.finish().rows).toHaveLength(maximumGpuProfileGroups);
  });

  it('bounds pending samples even when the application never reads timestamps', () => {
    using scope = createMeasurementFixture();
    using gpu = createGpuProfileFixture();
    for (let i = 0; i <= maximumPendingGpuProfilePasses; i++) {
      gpu.pass({ querySet: gpu.query() }).end();
    }
    expect(scope.finish()).toMatchObject({ pendingPasses: maximumPendingGpuProfilePasses, droppedPasses: 1, measuredPasses: 0 });
  });
});
