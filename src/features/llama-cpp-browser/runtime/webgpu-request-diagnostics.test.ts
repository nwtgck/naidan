import { createCoreWebGpuNavigator } from './webgpu-dispatch';
import { describe, expect, it, vi } from 'vitest';
import { createGpuRequestObserver, associateGpuRequests, readGpuRequests } from './webgpu-request-diagnostics';

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
