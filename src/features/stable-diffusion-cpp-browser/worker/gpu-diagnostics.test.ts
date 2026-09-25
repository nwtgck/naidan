import { afterEach, expect, it, vi } from 'vitest';
import { observeImageGpu } from './gpu-diagnostics';

afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function harness() {
  const buffer = { object: 'native buffer' };
  const pipeline = { object: 'native pipeline' };
  const done = Promise.resolve();
  const pop = Promise.resolve({ message: 'allocation error' });
  const device = Object.assign(new EventTarget(), {
    features: new Set(['shader-f16']), limits: { maxBufferSize: 1024, maxStorageBufferBindingSize: 512, maxComputeWorkgroupsPerDimension: 65535 },
    lost: new Promise(() => {}), createShaderModule: vi.fn(() => ({})), createBuffer: vi.fn(() => buffer), createComputePipeline: vi.fn(() => pipeline),
    createComputePipelineAsync: vi.fn(() => Promise.resolve(pipeline)), popErrorScope: vi.fn(() => pop),
    queue: { writeBuffer: vi.fn(), submit: vi.fn(), onSubmittedWorkDone: vi.fn(() => done) },
  });
  const adapter = { requestDevice: vi.fn(async () => device) };
  const gpu = { requestAdapter: vi.fn(async () => adapter) };
  vi.stubGlobal('navigator', { gpu });
  const original = { request: gpu.requestAdapter, device: adapter.requestDevice, buffer: device.createBuffer, pipeline: device.createComputePipeline, submit: device.queue.submit, done: device.queue.onSubmittedWorkDone };
  const emit = vi.fn(); const observation = observeImageGpu({ emit });
  return { gpu, adapter, device, original, emit, observation, buffer, pipeline, done, pop };
}
it('observes only runtime-requested native objects and does not change GPU arguments or object identities', async () => {
  const h = harness();
  expect(h.original.request).not.toHaveBeenCalled(); expect(h.original.device).not.toHaveBeenCalled();
  const options = { powerPreference: 'high-performance' };
  const descriptor = { requiredFeatures: ['shader-f16'], requiredLimits: { maxBufferSize: 1024 } };
  // Test object signatures are deliberately narrow; calls below use the platform contract.
  const gpu = h.gpu as unknown as GPU;
  const actual = await gpu.requestAdapter(options as GPURequestAdapterOptions);
  const device = await actual!.requestDevice(descriptor as GPUDeviceDescriptor);
  expect(actual).toBe(h.adapter); expect(device).toBe(h.device);
  expect(h.original.request).toHaveBeenCalledWith(options); expect(h.original.device).toHaveBeenCalledWith(descriptor);
  const bufferDescriptor = { size: 16, usage: 8 };
  expect(device.createBuffer(bufferDescriptor)).toBe(h.buffer);
  const pipelineDescriptor = {} as GPUComputePipelineDescriptor;
  expect(device.createComputePipeline(pipelineDescriptor)).toBe(h.pipeline);
  expect(h.original.buffer).toHaveBeenCalledWith(bufferDescriptor); expect(h.original.pipeline).toHaveBeenCalledWith(pipelineDescriptor);
  expect(device.queue.onSubmittedWorkDone()).toBe(h.done);
  expect(device.popErrorScope()).toBe(h.pop);
  await Promise.resolve();
  expect(h.emit.mock.calls.some(([event]) => event.message.includes('error scope'))).toBe(true);
  expect(h.emit.mock.calls.some(([event]) => event.fields.shaderF16 === true)).toBe(true);
  h.observation.dispose();
  expect(h.gpu.requestAdapter).toBe(h.original.request); expect(h.adapter.requestDevice).toBe(h.original.device);
  expect(h.device.createBuffer).toBe(h.original.buffer); expect(h.device.queue.submit).toBe(h.original.submit);
});
it('does not replace a native exception with a diagnostic failure', async () => {
  const h = harness(); const nativeError = new Error('native allocation rejected');
  h.original.buffer.mockImplementation(() => {
    throw nativeError;
  });
  await (await h.gpu.requestAdapter())!.requestDevice();
  h.emit.mockImplementation(() => {
    throw new Error('log sink failed');
  });
  expect(() => h.device.createBuffer()).toThrow(nativeError);
  h.observation.dispose();
});
it('does not install late callbacks or observers after disposal', async () => {
  const h = harness(); const pending = h.gpu.requestAdapter(); h.observation.dispose(); await pending;
  expect(h.adapter.requestDevice).toBe(h.original.device);
  const count = h.emit.mock.calls.length; await h.adapter.requestDevice();
  expect(h.emit).toHaveBeenCalledTimes(count);
});
it('does nothing when the platform has no usable GPU entry point', () => {
  vi.stubGlobal('navigator', { gpu: {} }); const emit = vi.fn();
  expect(() => observeImageGpu({ emit }).dispose()).not.toThrow(); expect(emit).not.toHaveBeenCalled();
});
