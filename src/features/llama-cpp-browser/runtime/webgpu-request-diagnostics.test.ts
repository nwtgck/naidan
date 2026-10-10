import { createCoreWebGpuNavigator } from './webgpu-dispatch';
import { describe, expect, it, vi } from 'vitest';
import { beginGpuMeasurement, createGpuRequestObserver, associateGpuRequests, readGpuRequests } from './webgpu-request-diagnostics';

function fixture() {
  const buffers = new WeakSet<object>();
  const queue = {
    writeBuffer: vi.fn(function (this: unknown, buffer: object, offset: number) {
      expect(this).toBe(queue); expect(buffers.has(buffer)).toBe(true);
      if (offset < 0) throw failure;
    }),
  };
  const failure = new Error('native failure');
  const device = {
    queue,
    limits: { maxComputeWorkgroupsPerDimension: 65535 },
    createBuffer: vi.fn(function (this: unknown, descriptor: GPUBufferDescriptor) {
      expect(this).toBe(device);
      const size = descriptor.size;
      if (size < 0) throw failure;
      const buffer = Object.freeze({ size }); buffers.add(buffer); return buffer;
    }),
  };
  return { device: device as unknown as GPUDevice, failure, queue, buffers };
}

describe('passive GPU API request totals', () => {
  it('preserves actual buffer identity and does not read descriptor getters twice', () => {
    const raw = fixture(); const observer = createGpuRequestObserver();
    expect(observer.snapshot()).toMatchObject({ bufferCount: 0, writeCount: 0 });
    const device = observer.wrapDevice({ device: raw.device });
    const size = vi.fn(() => 64);
    const buffer = device.createBuffer({
      get size() {
        return size();
      },
      usage: 0,
    });
    expect(size).toHaveBeenCalledTimes(1); expect(raw.buffers.has(buffer)).toBe(true);
    expect(Object.isFrozen(buffer)).toBe(true);
    expect(observer.snapshot()).toMatchObject({ bufferBytes: 64, bufferCount: 1 });
  });

  it('counts TypedArray elements and ArrayBuffer/DataView bytes without copying or changing arguments', () => {
    const raw = fixture(); const observer = createGpuRequestObserver(); const device = observer.wrapDevice({ device: raw.device });
    const buffer = device.createBuffer({ size: 128, usage: 0 });
    const floats = new Float32Array(10);
    device.queue.writeBuffer(buffer, 0, floats, 2, 3);
    expect(raw.queue.writeBuffer.mock.calls[0]).toEqual([buffer, 0, floats, 2, 3]);
    device.queue.writeBuffer(buffer, 0, new DataView(new ArrayBuffer(20)), 4);
    device.queue.writeBuffer(buffer, 0, new ArrayBuffer(20), 8, 4);
    device.queue.writeBuffer(buffer, 0, new Uint8Array(4 * 1024 * 1024));
    device.queue.writeBuffer(buffer, 0, new SharedArrayBuffer(12), 4);
    expect(observer.snapshot()).toMatchObject({ writeCount: 5, writeBytes: 4 * 1024 * 1024 + 40, largestWriteBytes: 4 * 1024 * 1024, writesAtLeast4MiB: 1 });
  });

  it('preserves native error identity and excludes synchronously rejected calls', () => {
    const raw = fixture(); const observer = createGpuRequestObserver(); const device = observer.wrapDevice({ device: raw.device });
    const buffer = device.createBuffer({ size: 128, usage: 0 });
    try {
      device.createBuffer({ size: -1, usage: 0 }); expect.fail('Expected native error');
    } catch (error) {
      expect(error).toBe(raw.failure);
    }
    try {
      device.queue.writeBuffer(buffer, -1, new Uint8Array(1)); expect.fail('Expected native error');
    } catch (error) {
      expect(error).toBe(raw.failure);
    }
    expect(observer.snapshot()).toMatchObject({ bufferCount: 1, writeCount: 0 });
  });

  it('drops unavailable diagnostic counters without replacing a native result', () => {
    const raw = fixture(); const observer = createGpuRequestObserver(); const device = observer.wrapDevice({ device: raw.device });
    const result = device.createBuffer({ size: Number.MAX_SAFE_INTEGER, usage: 0 });
    expect(result.size).toBe(Number.MAX_SAFE_INTEGER);
    expect(device.createBuffer({ size: 1, usage: 0 }).size).toBe(1);
    expect(observer.snapshot()).toBeUndefined();
  });

  it('isolates runtime counters and returns immutable snapshots', () => {
    const first = createGpuRequestObserver(); const second = createGpuRequestObserver();
    const core = {}; associateGpuRequests({ core, snapshot: first.snapshot });
    const device = first.wrapDevice({ device: fixture().device });
    device.createBuffer({ size: 1, usage: 0 });
    const old = readGpuRequests({ core })!;
    device.createBuffer({ size: 2, usage: 0 });
    expect(old.bufferBytes).toBe(1); expect(readGpuRequests({ core })!.bufferBytes).toBe(3);
    expect(second.snapshot()).toMatchObject({ bufferBytes: 0, writeBytes: 0 }); expect(readGpuRequests({ core: {} })).toBeUndefined();
  });
});

it('does not turn a diagnostic size getter failure into a failed native operation', () => {
  const observer = createGpuRequestObserver();
  const buffer = {
    get size(): number {
      throw new Error('diagnostic read');
    },
  };
  const device = observer.wrapDevice({ device: { queue: {}, createBuffer: () => buffer } as unknown as GPUDevice });
  expect(device.createBuffer({ size: 10, usage: 0 })).toBe(buffer);
  expect(observer.snapshot()).toBeUndefined();
  associateGpuRequests({
    core: buffer,
    snapshot() {
      throw new Error('diagnostic snapshot');
    },
  });
  expect(readGpuRequests({ core: buffer })).toBeUndefined();
});

it('composes with the real dispatch navigator without eagerly requesting adapters or devices', async () => {
  const raw = fixture(); const observer = createGpuRequestObserver();
  const adapter = {
    requestDevice: vi.fn(function (this: unknown) {
      expect(this).toBe(adapter); return Promise.resolve(raw.device);
    }),
  };
  const gpu = {
    requestAdapter: vi.fn(function (this: unknown) {
      expect(this).toBe(gpu); return Promise.resolve(adapter);
    }),
  };
  const navigator = { gpu } as unknown as Pick<Navigator, 'gpu'>;
  const scoped = createCoreWebGpuNavigator({ navigator, report() {}, observeDevice: observer.wrapDevice })!;
  expect(gpu.requestAdapter).not.toHaveBeenCalled(); expect(adapter.requestDevice).not.toHaveBeenCalled();
  const scopedAdapter = await scoped.gpu.requestAdapter();
  const device = await scopedAdapter!.requestDevice();
  const buffer = device.createBuffer({ size: 1024, usage: 0 });
  device.queue.writeBuffer(buffer, 0, new Uint8Array(256));
  expect(raw.buffers.has(buffer)).toBe(true);
  expect(observer.snapshot()).toMatchObject({ bufferCount: 1, bufferBytes: 1024, writeCount: 1, writeBytes: 256 });
  expect(gpu.requestAdapter).toHaveBeenCalledTimes(1); expect(adapter.requestDevice).toHaveBeenCalledTimes(1);
  expect(navigator.gpu).toBe(gpu); expect(raw.device.queue).toBe(raw.queue);
});

function queueFixture({ promise }: { promise: Promise<void> }) {
  const queue = {
    submit: vi.fn(function (this: unknown) {
      expect(this).toBe(queue);
    }),
    onSubmittedWorkDone: vi.fn(function (this: unknown) {
      expect(this).toBe(queue); return promise;
    }),
  };
  const observer = createGpuRequestObserver();
  const device = observer.wrapDevice({ device: { queue } as unknown as GPUDevice });
  return { queue, observer, device };
}

describe('measurement-only existing queue completion observations', () => {
  it('preserves original promise identity, native receiver and immutable wall-duration snapshots', async () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
      resolve = done;
    });
    const { device, observer, queue } = queueFixture({ promise });
    let now = 10;
    const finish = beginGpuMeasurement({ now: () => now });
    try {
      const commands: GPUCommandBuffer[] = [];
      device.queue.submit(commands);
      expect(device.queue.onSubmittedWorkDone()).toBe(promise);
      const old = observer.snapshot()!;
      expect(old.queue).toMatchObject({ submitCount: 1, completionWaitCount: 1, completionWaitPending: 1 });
      now = 35; resolve(); await promise;
      expect(observer.snapshot()!.queue).toMatchObject({ completionWaitResolved: 1, completionWaitPending: 0, completionWaitDurationMs: 25 });
      expect(old.queue!.completionWaitPending).toBe(1);
      expect(queue.submit).toHaveBeenCalledExactlyOnceWith(commands);
      expect(queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    } finally {
      finish();
    }
  });

  it('preserves rejection identity without an unhandled observer promise', async () => {
    const error = new Error('device lost');
    const promise = Promise.reject(error);
    const { device, observer } = queueFixture({ promise });
    const finish = beginGpuMeasurement({ now: () => 10 });
    try {
      expect(device.queue.onSubmittedWorkDone()).toBe(promise);
      await expect(promise).rejects.toBe(error);
      expect(observer.snapshot()!.queue).toMatchObject({ completionWaitRejected: 1, completionWaitPending: 0 });
    } finally {
      finish();
    }
  });

  it('ignores late settlements and stale disposals during the next request', async () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
      resolve = done;
    });
    const { device, observer } = queueFixture({ promise });
    const first = beginGpuMeasurement({ now: () => 0 });
    device.queue.onSubmittedWorkDone();
    first();
    const second = beginGpuMeasurement({ now: () => 20 });
    try {
      device.queue.submit([]); first(); resolve(); await promise;
      expect(observer.snapshot()!.queue).toMatchObject({ submitCount: 1, completionWaitCount: 0, completionWaitResolved: 0, completionWaitPending: 0 });
    } finally {
      second();
    }
    expect(observer.snapshot()!.queue).toBeUndefined();
  });

  it('does not observe promise settlements, time, or add queue calls outside measurements', () => {
    const promise = Promise.resolve();
    const then = vi.spyOn(promise, 'then');
    const { device, queue, observer } = queueFixture({ promise });
    // Vitest's mock itself attaches a settlement observer to returned promises.
    let calls = 0;
    Object.assign(queue, {
      onSubmittedWorkDone() {
        calls++; return promise;
      },
    });
    device.queue.submit([]);
    expect(device.queue.onSubmittedWorkDone()).toBe(promise);
    expect(then).not.toHaveBeenCalled();
    expect(calls).toBe(1);
    expect(observer.snapshot()!.queue).toBeUndefined();
  });

  it('keeps synchronous native errors and tolerates failing clocks', async () => {
    const promise = Promise.resolve();
    const { device, observer, queue } = queueFixture({ promise });
    const finish = beginGpuMeasurement({
      now: () => {
        throw new Error('clock');
      },
    });
    try {
      expect(device.queue.onSubmittedWorkDone()).toBe(promise); await promise;
      expect(observer.snapshot()!.queue).toMatchObject({ completionWaitResolved: 1, completionWaitDurationMs: undefined, longestCompletionWaitDurationMs: undefined });
      const error = new Error('native');
      queue.submit.mockImplementation(() => {
        throw error;
      });
      expect(() => device.queue.submit([])).toThrow(error);
      expect(observer.snapshot()!.queue!.submitCount).toBe(0);
    } finally {
      finish();
    }
  });
});

it('captures only actual selected adapter/device metadata, treating redaction and failures as unavailable', async () => {
  const raw = fixture();
  Object.assign(raw.device, { features: new Set(['shader-f16']) });
  const observer = createGpuRequestObserver();
  const adapter = {
    info: {
      vendor: 'vendor',
      architecture: '',
      device: '',
      get description() {
        throw new Error('redacted');
      },
    },
    isFallbackAdapter: false,
    features: new Set(['timestamp-query', 'shader-f16']),
    requestDevice: vi.fn(() => Promise.resolve(raw.device)),
  };
  const gpu = { requestAdapter: vi.fn(() => Promise.resolve(adapter)) };
  const navigator = createCoreWebGpuNavigator({ navigator: { gpu } as unknown as Pick<Navigator, 'gpu'>, report() {}, observeDevice: observer.wrapDevice })!;
  expect(observer.snapshot()!.metadata).toBeUndefined();
  const selected = await navigator.gpu.requestAdapter(); await selected!.requestDevice();
  const snapshot = observer.snapshot()!;
  expect(snapshot.metadata).toEqual({ adapterInfo: { vendor: 'vendor' }, fallbackAdapter: false, adapterFeatures: ['shader-f16', 'timestamp-query'], deviceFeatures: ['shader-f16'], deviceLimits: { maxComputeWorkgroupsPerDimension: 65535 } });
  snapshot.metadata!.adapterInfo!.vendor = 'changed';
  expect(observer.snapshot()!.metadata!.adapterInfo!.vendor).toBe('vendor');
  expect(gpu.requestAdapter).toHaveBeenCalledTimes(1); expect(adapter.requestDevice).toHaveBeenCalledTimes(1);
});

it('prefers current adapter-info fallback status over the legacy adapter property', () => {
  const observer = createGpuRequestObserver();
  observer.wrapDevice({ device: fixture().device, adapter: { info: { isFallbackAdapter: true }, isFallbackAdapter: false } as unknown as GPUAdapter });
  expect(observer.snapshot()!.metadata!.fallbackAdapter).toBe(true);
});

it('caps outstanding native wait observers across closed request windows without changing original promises', async () => {
  const gate = Promise.withResolvers<void>();
  const { device, observer, queue } = queueFixture({ promise: gate.promise });
  // Avoid Vitest mock promise bookkeeping when counting observer reactions.
  Object.assign(queue, { onSubmittedWorkDone: () => gate.promise });
  const then = vi.spyOn(gate.promise, 'then');
  const closeFirst = beginGpuMeasurement({ now: () => 1 });
  for (let i = 0; i < 300; i++) expect(device.queue.onSubmittedWorkDone()).toBe(gate.promise);
  const first = observer.snapshot()!;
  expect(first.queue).toMatchObject({ completionWaitCount: 300, completionWaitPending: 256, completionWaitUnobserved: 44 });
  expect(then).toHaveBeenCalledTimes(256);
  closeFirst();
  const closeSecond = beginGpuMeasurement({ now: () => 2 });
  try {
    expect(device.queue.onSubmittedWorkDone()).toBe(gate.promise);
    expect(observer.snapshot()!.queue).toMatchObject({ completionWaitCount: 1, completionWaitPending: 0, completionWaitUnobserved: 1 });
    expect(then).toHaveBeenCalledTimes(256);
    gate.resolve(); await gate.promise;
    // Old settlement frees observer slots, but cannot mutate either old snapshot
    // or the new request's outcomes. It never reports skipped waits as complete.
    expect(first.queue!.completionWaitPending).toBe(256);
    expect(observer.snapshot()!.queue).toMatchObject({ completionWaitResolved: 0, completionWaitPending: 0, completionWaitUnobserved: 1 });
    device.queue.onSubmittedWorkDone(); await gate.promise;
    expect(observer.snapshot()!.queue).toMatchObject({ completionWaitCount: 2, completionWaitResolved: 1, completionWaitPending: 0, completionWaitUnobserved: 1 });
  } finally {
    closeSecond(); then.mockRestore();
  }
});

it('keeps the bounded completion observer budget local to each runtime', () => {
  const never = new Promise<void>(() => {});
  const first = queueFixture({ promise: never });
  const second = queueFixture({ promise: never });
  const closeFirst = beginGpuMeasurement({ now: () => 0 });
  for (let i = 0; i < 256; i++) first.device.queue.onSubmittedWorkDone();
  closeFirst();
  const closeSecond = beginGpuMeasurement({ now: () => 1 });
  try {
    first.device.queue.onSubmittedWorkDone();
    second.device.queue.onSubmittedWorkDone();
    expect(first.observer.snapshot()!.queue).toMatchObject({ completionWaitUnobserved: 1, completionWaitPending: 0 });
    expect(second.observer.snapshot()!.queue).toMatchObject({ completionWaitUnobserved: 0, completionWaitPending: 1 });
  } finally {
    closeSecond();
  }
});
