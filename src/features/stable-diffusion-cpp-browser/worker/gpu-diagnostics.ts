import type { ImageDiagnosticInput, createImageTrace } from '@/features/stable-diffusion-cpp-browser/diagnostics';

/** Observe only the device requested by the image runtime. Never request an
 * extra adapter/device, change features/limits, shaders, precision or dispatch.
 * All modifications are confined to the disposable image Worker, restored on
 * exit. The native GPU objects themselves (not proxies) are returned. */
export function observeImageGpu({ emit, debug }: { emit: ReturnType<typeof createImageTrace>['emit'], debug: 'off' | 'on' }): { dispose(): void } {
  const undo: (() => void)[] = []; let disposed = false;
  const adapters = new WeakSet<GPUAdapter>(), devices = new WeakSet<GPUDevice>();
  const report = ({ message, fields }: { message: string, fields: ImageDiagnosticInput['fields'] }) => {
    if (disposed) return;
    try {
      emit({ event: 'gpu', stage: 'generation', message, fields });
    } catch { /* diagnostic only */ }
  };
  function override<T extends object, K extends keyof T>({ target, key, value }: { target: T, key: K, value: T[K] }): void {
    const before = Object.getOwnPropertyDescriptor(target, key);
    try {
      Object.defineProperty(target, key, { configurable: true, writable: true, value });
      undo.push(() => {
        if (before) Object.defineProperty(target, key, before); else Reflect.deleteProperty(target, key);
      });
    } catch {
      report({ message: 'WebGPU observation unavailable for this method', fields: { method: String(key) } });
    }
  }
  function observeDevice({ device }: { device: GPUDevice }): void {
    if (devices.has(device)) return;
    devices.add(device);
    report({ message: 'runtime device acquired', fields: {
      shaderF16: device.features.has('shader-f16'), maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
    } });
    const lost = () => device.lost.then(info => report({ message: 'device lost: ' + info.message, fields: { reason: info.reason } })).catch(() => undefined);
    void lost();
    const error: EventListener = event => {
      const value = event as GPUUncapturedErrorEvent;
      report({ message: 'uncaptured GPU error: ' + value.error.message, fields: { name: value.error.constructor.name } });
    };
    device.addEventListener('uncapturederror', error);
    undo.push(() => device.removeEventListener('uncapturederror', error));
    // Device failures are essential even when detailed timing/counters are off.
    switch (debug) {
    case 'off': return;
    case 'on': break;
    default: { const exhaustive: never = debug; throw new Error(String(exhaustive)); }
    }
    let buffers = 0, requestedBytes = 0, shaders = 0, pipelines = 0, uploads = 0, submissions = 0, workDone = 0, sampled = 0;
    function sample(): void {
      const now = performance.now(); if (now - sampled < 2000) return; sampled = now;
      report({ message: 'WebGPU activity (buffer bytes are cumulative requests, not live VRAM)', fields: { buffers, requestedBytes, shaders, pipelines, uploads, submissions, workDone } });
    }
    const buffer = device.createBuffer.bind(device);
    override({ target: device, key: 'createBuffer', value: descriptor => {
      const result = buffer(descriptor); buffers++; requestedBytes += descriptor.size; sample(); return result;
    } });
    const shader = device.createShaderModule.bind(device);
    override({ target: device, key: 'createShaderModule', value: descriptor => {
      const started = performance.now(); shaders++;
      if (shaders <= 4) report({ message: 'shader module start', fields: { shaders, sourceCharacters: descriptor.code.length } });
      const result = shader(descriptor);
      if (performance.now() - started > 500 || shaders <= 4) report({ message: 'shader module complete', fields: { shaders, milliseconds: performance.now() - started } });
      sample(); return result;
    } });
    const upload = device.queue.writeBuffer.bind(device.queue);
    override({ target: device.queue, key: 'writeBuffer', value: (buffer, offset, data, dataOffset, size) => {
      upload(buffer, offset, data, dataOffset, size); uploads++; sample();
    } });
    const pipeline = device.createComputePipeline.bind(device);
    override({ target: device, key: 'createComputePipeline', value: descriptor => {
      const started = performance.now(); pipelines++;
      if (pipelines <= 4) report({ message: 'compute pipeline start', fields: { pipelines } });
      const result = pipeline(descriptor);
      if (performance.now() - started > 500 || pipelines <= 4) report({ message: 'compute pipeline complete', fields: { pipelines, milliseconds: performance.now() - started } });
      sample(); return result;
    } });
    const asyncPipeline = device.createComputePipelineAsync.bind(device);
    override({ target: device, key: 'createComputePipelineAsync', value: descriptor => {
      const started = performance.now(); pipelines++;
      report({ message: 'async compute pipeline start', fields: { pipelines } });
      const pending = asyncPipeline(descriptor);
      void pending.then(() => report({ message: 'async compute pipeline complete', fields: { milliseconds: performance.now() - started } }), error => report({ message: String(error), fields: {} }));
      return pending;
    } });
    const submit = device.queue.submit.bind(device.queue);
    override({ target: device.queue, key: 'submit', value: commands => {
      submit(commands); submissions++; sample();
    } });
    const done = device.queue.onSubmittedWorkDone.bind(device.queue);
    override({ target: device.queue, key: 'onSubmittedWorkDone', value: () => {
      const pending = done(); const started = performance.now();
      void pending.then(() => {
        workDone++; sample(); if (performance.now() - started > 2000) report({ message: 'GPU queue wait complete', fields: { milliseconds: performance.now() - started } });
      }, error => report({ message: 'GPU queue wait failed: ' + String(error), fields: {} }));
      return pending;
    } });
    const pop = device.popErrorScope.bind(device);
    override({ target: device, key: 'popErrorScope', value: () => {
      const pending = pop();
      void pending.then(error => {
        if (error) report({ message: 'GPU error scope: ' + error.message, fields: { name: error.constructor.name } });
      }, () => undefined);
      return pending;
    } });
  }
  if (typeof navigator !== 'undefined' && typeof navigator.gpu?.requestAdapter === 'function') {
    const gpu = navigator.gpu; const request = gpu.requestAdapter.bind(gpu);
    override({ target: gpu, key: 'requestAdapter', value: async options => {
      report({ message: 'runtime adapter request', fields: {} });
      const adapter = await request(options);
      if (adapter && !disposed && !adapters.has(adapter)) {
        adapters.add(adapter);
        const device = adapter.requestDevice.bind(adapter);
        override({ target: adapter, key: 'requestDevice', value: async descriptor => {
          const actual = await device(descriptor); try {
            if (!disposed) observeDevice({ device: actual });
          } catch {
            report({ message: 'Some GPU diagnostics could not be installed', fields: {} });
          } return actual;
        } });
      } else if (!adapter) report({ message: 'no GPU adapter', fields: {} });
      return adapter;
    } });
  }
  return { dispose() {
    disposed = true; for (const restore of undo.reverse()) {
      try {
        restore();
      } catch { /* Worker is about to terminate. */ }
    }
  } };
}
export const TEST_ONLY = {
};
