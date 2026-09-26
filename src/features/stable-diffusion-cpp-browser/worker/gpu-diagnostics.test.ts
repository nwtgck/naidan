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
  const emit = vi.fn(); const observation = observeImageGpu({ emit, debug: 'on' });
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
  expect(() => observeImageGpu({ emit, debug: 'on' }).dispose()).not.toThrow(); expect(emit).not.toHaveBeenCalled();
});

it('keeps critical GPU errors with debug off without instrumenting buffers or pipelines', async () => {
  const h = harness(); h.observation.dispose();
  const observation = observeImageGpu({ emit: h.emit, debug: 'off' });
  try {
    await (await h.gpu.requestAdapter())!.requestDevice();
    expect(h.device.createBuffer).toBe(h.original.buffer);
    expect(h.device.createComputePipeline).toBe(h.original.pipeline);
    const event = new Event('uncapturederror');
    Object.defineProperty(event, 'error', { value: { message: 'Dispatch 65536 exceeds 65535' } });
    h.device.dispatchEvent(event);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'gpu', message: expect.stringContaining('65536') }));
  } finally {
    observation.dispose();
  }
});

it('counts caller bytes and physical dispatches without adding device work or changing descriptors', async () => {
  let time = 0; const emit = vi.fn();
  const originalMap = vi.fn(() => Promise.resolve());
  const source = { size: 1024, usage: 0x80, mapAsync: originalMap };
  const target = { size: 512, usage: 1, mapAsync: originalMap };
  const dispatch = vi.fn(), indirect = vi.fn(), beginPass = vi.fn(() => ({ dispatchWorkgroups: dispatch, dispatchWorkgroupsIndirect: indirect }));
  const copy = vi.fn(), createEncoder = vi.fn(() => ({ copyBufferToBuffer: copy, beginComputePass: beginPass }));
  const q = { writeBuffer: vi.fn(), submit: vi.fn(), onSubmittedWorkDone: vi.fn(() => Promise.resolve()) };
  const device = Object.assign(new EventTarget(), { features: new Set(['timestamp-query']), limits: { maxBufferSize: 1024, maxStorageBufferBindingSize: 1024, maxComputeWorkgroupsPerDimension: 65535 },
    lost: new Promise(() => {}), createBuffer: vi.fn(() => source), createShaderModule: vi.fn(), createComputePipeline: vi.fn(), createComputePipelineAsync: vi.fn(async () => ({})), createCommandEncoder: createEncoder, popErrorScope: vi.fn(() => Promise.resolve(null)), queue: q });
  const originalDone = q.onSubmittedWorkDone;
  const adapter = { features: new Set(['timestamp-query']), requestDevice: vi.fn(async () => device) }, gpu = { requestAdapter: vi.fn(async () => adapter) };
  vi.stubGlobal('navigator', { gpu });
  const observer = observeImageGpu({ debug: 'on', emit, now: () => time }); observer.beginRun({ runId: 1 });
  const actual = await (await gpu.requestAdapter()).requestDevice() as unknown as GPUDevice;
  const buffer = actual.createBuffer({ size: 1024, usage: 0x80 });
  actual.queue.writeBuffer(buffer, 0, new Float32Array(16), 2, 3); // 12, not 3 bytes
  actual.queue.writeBuffer(buffer, 0, new DataView(new ArrayBuffer(64), 8, 16), 4); // 12 bytes
  const encoder = actual.createCommandEncoder(); encoder.copyBufferToBuffer(buffer, 0, target as unknown as GPUBuffer, 0, 64);
  encoder.copyBufferToBuffer(buffer, target as unknown as GPUBuffer, 128);
  encoder.copyBufferToBuffer(buffer, target as unknown as GPUBuffer); // inferred 512
  const descriptor = { label: 'secret not logged' };
  const pass = encoder.beginComputePass(descriptor); pass.dispatchWorkgroups(10, 2, 1); pass.dispatchWorkgroupsIndirect(buffer, 0);
  let consumed = 0; function* commands() {
    consumed++; yield {} as GPUCommandBuffer;
  }
  const iterable = commands(); actual.queue.submit(iterable);
  expect(consumed).toBe(0); // our stub does not iterate, so the observer must not either
  const wait = actual.queue.onSubmittedWorkDone(); time = 100; await wait;
  observer.endRun({ outcome: 'complete' });
  const total = emit.mock.calls.map(([e]) => e.fields).find(f => f.metric === 'gpu-counters' && f.scope === 'run-total');
  expect(total).toMatchObject({ writes: 2, writeBytes: 24, storageWriteBytes: 24, copies: 3, copyBytes: 704, copyToMapReadBytes: 704, computePasses: 1, dispatches: 1, indirectDispatches: 1, submissions: 1 });
  expect(beginPass).toHaveBeenCalledExactlyOnceWith(descriptor); expect(originalDone).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(emit.mock.calls)).not.toContain('secret');
  observer.dispose(); expect(actual.createCommandEncoder).toBe(createEncoder);
  pass.dispatchWorkgroups(1); expect(dispatch).toHaveBeenCalledTimes(2);
});
it('does not attribute a late queue completion to the next retained run', async () => {
  const h = harness(); h.observation.beginRun({ runId: 1 });
  const gate = Promise.withResolvers<void>(); h.original.done.mockReturnValueOnce(gate.promise);
  await (await h.gpu.requestAdapter())!.requestDevice(); h.device.queue.onSubmittedWorkDone();
  h.observation.endRun({ outcome: 'cancelled' }); h.observation.beginRun({ runId: 2 });
  gate.resolve(); await Promise.resolve(); h.observation.endRun({ outcome: 'complete' });
  const totals = h.emit.mock.calls.map(([e]) => e.fields).filter(f => f.metric === 'gpu-wait' && f.scope === 'run-total' && f.kind === 'queue');
  expect(totals).toHaveLength(2); expect(totals[0]).toMatchObject({ runId: 1, started: 1, settled: 0, pending: 1 });
  expect(totals[1]).toMatchObject({ runId: 2, started: 0, settled: 0, pending: 0 }); h.observation.dispose();
});

it('counts observed readback ranges and settlements without an additional map or queue wait', async () => {
  let time = 0;
  const h = harness(); h.observation.dispose();
  const gate = Promise.withResolvers<void>(), map = vi.fn(() => gate.promise);
  const raw = { size: 1024, usage: 1, mapAsync: map };
  h.original.buffer.mockReturnValue(raw as unknown as typeof h.buffer);
  const observation = observeImageGpu({ emit: h.emit, debug: 'on', now: () => time });
  observation.beginRun({ runId: 7 });
  const device = await (await h.gpu.requestAdapter())!.requestDevice() as unknown as GPUDevice;
  const buffer = device.createBuffer({ size: 1024, usage: 1 });
  const pending = buffer.mapAsync(1, 256);
  expect(pending).toBe(gate.promise); expect(map).toHaveBeenCalledExactlyOnceWith(1, 256);
  time = 4; observation.checkpoint({ point: { phase: 'sampling', step: 1, reason: 'completed-step' } });
  time = 9; gate.resolve(); await pending; observation.endRun({ outcome: 'complete' });
  const fields = h.emit.mock.calls.map(([event]) => event.fields);
  expect(fields.find(f => f.metric === 'gpu-counters' && f.scope === 'run-total')).toMatchObject({ mapReadRequests: 1, mapReadBytes: 768 });
  expect(fields.find(f => f.metric === 'gpu-wait' && f.kind === 'map' && f.scope === 'run-total')).toMatchObject({ started: 1, settled: 1, pending: 0, wallSumMs: 9, wallUnionMs: 9 });
  expect(h.original.done).not.toHaveBeenCalled(); observation.dispose();
});
it('reports missing coverage rather than changing an immutable GPU method', async () => {
  const h = harness(); const original = h.device.queue.writeBuffer;
  Object.defineProperty(h.device.queue, 'writeBuffer', { value: original, configurable: false, writable: false });
  h.observation.beginRun({ runId: 1 });
  await (await h.gpu.requestAdapter())!.requestDevice();
  expect(h.device.queue.writeBuffer).toBe(original);
  h.observation.endRun({ outcome: 'complete' });
  expect(h.emit.mock.calls.some(([event]) => event.fields.metric === 'gpu-observation-end' && event.fields.unavailableMethods.includes('writeBuffer'))).toBe(true);
  h.observation.dispose();
});
it('does not re-read a creation descriptor and never replaces a native result with invalid metadata', async () => {
  const h = harness(); h.observation.beginRun({ runId: 1 });
  let reads = 0;
  const descriptor = { get size() {
    reads++; return 16;
  }, usage: 0x80 };
  const raw = { get size() {
    throw new Error('observation unavailable');
  }, usage: 0x80, mapAsync: vi.fn(async () => undefined) };
  h.original.buffer.mockImplementation((...args: unknown[]) => {
    void (args[0] as GPUBufferDescriptor).size; return raw as unknown as typeof h.buffer;
  });
  const device = await (await h.gpu.requestAdapter())!.requestDevice() as unknown as GPUDevice;
  expect(device.createBuffer(descriptor)).toBe(raw); expect(reads).toBe(1);
  expect(() => device.queue.writeBuffer(raw as unknown as GPUBuffer, 0, new Uint8Array(4))).not.toThrow();
  h.observation.endRun({ outcome: 'complete' });
  expect(h.emit.mock.calls.some(([event]) => event.fields.metric === 'gpu-observation-end' && event.fields.unavailableMethods.includes('buffer-metadata'))).toBe(true);
  h.observation.dispose();
});
it('keeps diagnostic counters inactive with debug OFF even when lifecycle hooks run', async () => {
  const h = harness(); h.observation.dispose(); h.emit.mockClear();
  const clock = vi.fn(() => 0), observation = observeImageGpu({ emit: h.emit, debug: 'off', now: clock });
  observation.beginRun({ runId: 1 }); await (await h.gpu.requestAdapter())!.requestDevice();
  observation.checkpoint({ point: { phase: 'sampling', step: 2, reason: 'completed-step' } });
  observation.endRun({ outcome: 'complete' });
  expect(clock).not.toHaveBeenCalled();
  expect(h.emit.mock.calls.some(([event]) => event.fields.metric)).toBe(false);
  expect(h.device.createBuffer).toBe(h.original.buffer); observation.dispose();
});
