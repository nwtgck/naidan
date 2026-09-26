import type { ImageDiagnosticInput, createImageTrace } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { createGpuMeasurements, type MeasurementOutcome, type MeasurementPoint } from './gpu-performance';
import { uploadByteLength } from './performance-counters';

/** Observes the runtime's own objects and calls. No extra adapter/device, query
 * sets, waits, submissions, tensor copies, shader edits or changed descriptors.
 * Long-lived acquisition methods are restored on disposal. Ephemeral object
 * wrappers are NOT retained in an undo list: their closures die with the native
 * buffer/encoder/pass, and become forwarding-only after observer disposal. */
export function observeImageGpu({ emit, debug, now = () => performance.now() }: {
  emit: ReturnType<typeof createImageTrace>['emit'], debug: 'off' | 'on', now?: () => number,
}) {
  const undo: (() => void)[] = [];
  let disposed = false;
  const adapters = new WeakSet<GPUAdapter>(), devices = new WeakSet<GPUDevice>();
  const metrics = createGpuMeasurements({ emit, now });
  const buffers = new WeakMap<GPUBuffer, { size: number, usage: number }>();
  function bufferInfo({ buffer }: { buffer: GPUBuffer }): { size: number, usage: number } | undefined {
    let info = buffers.get(buffer);
    if (info) return info;
    try {
      const size = buffer.size, usage = buffer.usage;
      if (Number.isSafeInteger(size) && size >= 0 && Number.isSafeInteger(usage)) {
        info = { size, usage }; buffers.set(buffer, info); return info;
      }
    } catch { /* Never replace a successful native call with an observation error. */ }
    metrics.unavailable({ method: 'buffer-metadata' }); return undefined;
  }
  const report = ({ message, fields }: { message: string, fields: ImageDiagnosticInput['fields'] }): void => {
    if (!disposed) try {
      emit({ event: 'gpu', stage: 'generation', message, fields });
    } catch { /* diagnostic only */ }
  };
  function override<T extends object, K extends keyof T>({ target, key, value, persistent = false }: {
    target: T, key: K, value: T[K], persistent?: boolean,
  }): void {
    try {
      const before = Object.getOwnPropertyDescriptor(target, key);
      Object.defineProperty(target, key, { configurable: true, writable: true, value });
      if (persistent) undo.push(() => {
        if (before) Object.defineProperty(target, key, before); else Reflect.deleteProperty(target, key);
      });
    } catch {
      metrics.unavailable({ method: String(key) });
    }
  }
  function observeBuffer({ buffer }: { buffer: GPUBuffer }): void {
    if (typeof buffer.mapAsync !== 'function') {
      metrics.unavailable({ method: 'mapAsync' }); return;
    }
    const map = buffer.mapAsync;
    override({ target: buffer, key: 'mapAsync', value: function (this: GPUBuffer, ...args) {
      const pending = map.apply(this, args);
      const run = metrics.current(); if (disposed || !run) return pending;
      const [mode, offset = 0, size] = args, info = bufferInfo({ buffer: this });
      const bytes = size ?? (info ? info.size - offset : NaN);
      if (Number.isSafeInteger(bytes) && bytes >= 0) {
        if (mode & 1) {
          run.counts.mapReadRequests++; run.counts.mapReadBytes += bytes;
        } else if (mode & 2) {
          run.counts.mapWriteRequests++; run.counts.mapWriteBytes += bytes;
        }
      } else run.counts.mapBytesUnknown++;
      const finish = run.mapping.start();
      void pending.then(() => {
        if (!disposed && !run.closed) finish({ failed: false });
      }, () => {
        if (!disposed && !run.closed) finish({ failed: true });
      });
      return pending;
    } });
  }
  function observePass({ pass }: { pass: GPUComputePassEncoder }): void {
    const dispatch = pass.dispatchWorkgroups;
    if (typeof dispatch === 'function') override({ target: pass, key: 'dispatchWorkgroups', value: function (this: GPUComputePassEncoder, ...args) {
      const result = dispatch.apply(this, args), run = metrics.current();
      if (!disposed && run) run.counts.dispatches++;
      return result;
    } });
    else metrics.unavailable({ method: 'dispatchWorkgroups' });
    const indirect = pass.dispatchWorkgroupsIndirect;
    if (typeof indirect === 'function') override({ target: pass, key: 'dispatchWorkgroupsIndirect', value: function (this: GPUComputePassEncoder, ...args) {
      const result = indirect.apply(this, args), run = metrics.current();
      if (!disposed && run) run.counts.indirectDispatches++;
      return result;
    } });
    else metrics.unavailable({ method: 'dispatchWorkgroupsIndirect' });
  }
  function observeEncoder({ encoder }: { encoder: GPUCommandEncoder }): void {
    const copy = encoder.copyBufferToBuffer;
    if (typeof copy === 'function') override({ target: encoder, key: 'copyBufferToBuffer', value: function (this: GPUCommandEncoder,
      ...args: [GPUBuffer, GPUBuffer, number?] | [GPUBuffer, number, GPUBuffer, number, number?]
    ) {
      const result: void = Reflect.apply(copy, this, args), run = metrics.current();
      if (!disposed && run) {
        run.counts.copies++;
        const [source] = args;
        // Both WebGPU signatures, including omitted size; do not replace the
        // caller's arguments when forwarding to the native implementation.
        const offsetForm = typeof args[1] === 'number';
        const destination = (offsetForm ? args[2] : args[1]) as GPUBuffer;
        const sourceOffset = offsetForm ? Number(args[1]) : 0;
        const destinationOffset = offsetForm ? Number(args[3]) : 0;
        const explicitSize = offsetForm ? args[4] : args[2];
        const sourceInfo = bufferInfo({ buffer: source }), destinationInfo = bufferInfo({ buffer: destination });
        const bytes = explicitSize === undefined ? (sourceInfo && destinationInfo ? Math.min(sourceInfo.size - sourceOffset, destinationInfo.size - destinationOffset) : NaN) : explicitSize;
        if (typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0) {
          run.counts.copyBytes += bytes;
          if (destinationInfo && destinationInfo.usage & 1) run.counts.copyToMapReadBytes += bytes;
        } else run.counts.copyBytesUnknown++;
      }
      return result;
    } });
    else metrics.unavailable({ method: 'copyBufferToBuffer' });
    const begin = encoder.beginComputePass;
    if (typeof begin === 'function') override({ target: encoder, key: 'beginComputePass', value: function (this: GPUCommandEncoder, ...args) {
      const pass = begin.apply(this, args), run = metrics.current();
      if (!disposed) {
        if (run) run.counts.computePasses++;
        try {
          observePass({ pass });
        } catch {
          metrics.unavailable({ method: 'compute-pass-observation' });
        }
      }
      return pass;
    } });
    else metrics.unavailable({ method: 'beginComputePass' });
  }
  function observeDevice({ device, adapter }: { device: GPUDevice, adapter: GPUAdapter }): void {
    if (devices.has(device)) return;
    devices.add(device);
    const facts: ImageDiagnosticInput['fields'] = {
      shaderF16: device.features.has('shader-f16'), maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
      adapterTimestampQuery: adapter.features?.has('timestamp-query') ?? false,
      deviceTimestampQuery: device.features.has('timestamp-query'), gpuTimestampsMeasured: false,
      subgroups: device.features.has('subgroups'),
    };
    // Do not fetch high-entropy adapter info or device IDs. Feature availability
    // is recorded without requesting additional features or changing limits.
    report({ message: 'runtime device acquired', fields: facts });
    void device.lost.then(info => report({ message: 'device lost: ' + info.message, fields: { reason: info.reason } })).catch(() => undefined);
    const error: EventListener = event => {
      const value = event as GPUUncapturedErrorEvent;
      report({ message: 'uncaptured GPU error: ' + value.error.message, fields: { name: value.error.constructor.name } });
    };
    device.addEventListener('uncapturederror', error);
    undo.push(() => device.removeEventListener('uncapturederror', error));
    // Existing critical failure observation also remains enabled in debug OFF.
    switch (debug) {
    case 'off': return;
    case 'on': break;
    default: { const exhaustive: never = debug; throw new Error(String(exhaustive)); }
    }
    metrics.device({ fields: facts });
    const buffer = device.createBuffer;
    override({ target: device, key: 'createBuffer', persistent: true, value: function (this: GPUDevice, ...args) {
      const result = buffer.apply(this, args), run = metrics.current();
      if (!disposed) {
        if (run) {
          run.counts.buffers++;
          const info = bufferInfo({ buffer: result });
          // Do not re-read a caller descriptor's size getter after the real API.
          if (info) run.counts.bufferBytesRequested += info.size;
        }
        try {
          observeBuffer({ buffer: result });
        } catch {
          metrics.unavailable({ method: 'mapAsync' });
        }
      }
      return result;
    } });
    const shader = device.createShaderModule;
    override({ target: device, key: 'createShaderModule', persistent: true, value: function (this: GPUDevice, ...args) {
      const run = disposed ? undefined : metrics.current(), start = run ? now() : 0;
      const result = shader.apply(this, args);
      if (!disposed && run) {
        run.counts.shaders++; run.counts.shaderHostMs += Math.max(0, now() - start);
      }
      return result;
    } });
    const pipeline = device.createComputePipeline;
    override({ target: device, key: 'createComputePipeline', persistent: true, value: function (this: GPUDevice, ...args) {
      const run = disposed ? undefined : metrics.current(), start = run ? now() : 0;
      const result = pipeline.apply(this, args);
      if (!disposed && run) {
        run.counts.pipelineSync++; run.counts.pipelineHostMs += Math.max(0, now() - start);
      }
      return result;
    } });
    const asyncPipeline = device.createComputePipelineAsync;
    if (typeof asyncPipeline === 'function') override({ target: device, key: 'createComputePipelineAsync', persistent: true, value: function (this: GPUDevice, ...args) {
      const run = disposed ? undefined : metrics.current(), start = run ? now() : 0;
      const pending = asyncPipeline.apply(this, args);
      if (!disposed && run) {
        run.counts.pipelineAsync++;
        void pending.then(() => {
          if (disposed || run.closed) return;
          run.counts.pipelineAsyncSettled++; run.counts.pipelineAsyncWallMs += Math.max(0, now() - start);
        }, () => {
          if (disposed || run.closed) return;
          run.counts.pipelineAsyncSettled++; run.counts.pipelineAsyncFailed++;
          run.counts.pipelineAsyncWallMs += Math.max(0, now() - start);
        });
      }
      return pending;
    } });
    const upload = device.queue.writeBuffer;
    override({ target: device.queue, key: 'writeBuffer', persistent: true, value: function (this: GPUQueue, ...args) {
      const result = upload.apply(this, args);
      if (!disposed && metrics.current()) metrics.write({ bytes: uploadByteLength({ data: args[2], dataOffset: args[3], size: args[4] }), usage: bufferInfo({ buffer: args[0] })?.usage ?? 0 });
      return result;
    } });
    const submit = device.queue.submit;
    override({ target: device.queue, key: 'submit', persistent: true, value: function (this: GPUQueue, ...args) {
      // Do NOT iterate commandBuffers: it can be a one-shot iterable.
      const result = submit.apply(this, args), run = metrics.current();
      if (!disposed && run) run.counts.submissions++;
      return result;
    } });
    const done = device.queue.onSubmittedWorkDone;
    override({ target: device.queue, key: 'onSubmittedWorkDone', persistent: true, value: function (this: GPUQueue, ...args) {
      const pending = done.apply(this, args), run = metrics.current();
      if (!disposed && run) {
        const finish = run.queue.start();
        void pending.then(() => {
          if (!disposed && !run.closed) finish({ failed: false });
        }, () => {
          if (!disposed && !run.closed) finish({ failed: true });
          report({ message: 'GPU queue wait failed', fields: {} });
        });
      }
      return pending;
    } });
    const encoder = device.createCommandEncoder;
    if (typeof encoder === 'function') override({ target: device, key: 'createCommandEncoder', persistent: true, value: function (this: GPUDevice, ...args) {
      const result = encoder.apply(this, args), run = metrics.current();
      if (!disposed) {
        if (run) run.counts.encoders++;
        try {
          observeEncoder({ encoder: result });
        } catch {
          metrics.unavailable({ method: 'command-encoder-observation' });
        }
      }
      return result;
    } });
    else metrics.unavailable({ method: 'createCommandEncoder' });
    const pop = device.popErrorScope;
    override({ target: device, key: 'popErrorScope', persistent: true, value: function (this: GPUDevice, ...args) {
      const pending = pop.apply(this, args);
      void pending.then(error => {
        if (error) report({ message: 'GPU error scope: ' + error.message, fields: { name: error.constructor.name } });
      }, () => undefined);
      return pending;
    } });
  }
  if (typeof navigator !== 'undefined' && typeof navigator.gpu?.requestAdapter === 'function') {
    const gpu = navigator.gpu, request = gpu.requestAdapter;
    override({ target: gpu, key: 'requestAdapter', persistent: true, value: async function (this: GPU, ...args) {
      report({ message: 'runtime adapter request', fields: {} });
      const adapter = await request.apply(this, args);
      if (adapter && !disposed && !adapters.has(adapter)) {
        adapters.add(adapter);
        const device = adapter.requestDevice;
        override({ target: adapter, key: 'requestDevice', persistent: true, value: async function (this: GPUAdapter, ...input) {
          const actual = await device.apply(this, input);
          try {
            if (!disposed) observeDevice({ device: actual, adapter });
          } catch {
            report({ message: 'Some GPU diagnostics could not be installed', fields: {} });
          }
          return actual;
        } });
      } else if (!adapter) report({ message: 'no GPU adapter', fields: {} });
      return adapter;
    } });
  }
  return {
    beginRun({ runId }: { runId: number }): void {
      if (debug === 'on' && !disposed) metrics.begin({ runId });
    },
    checkpoint({ point }: { point: MeasurementPoint }): void {
      if (!disposed) metrics.checkpoint({ point });
    },
    endRun({ outcome }: { outcome: MeasurementOutcome }): void {
      if (!disposed) metrics.finish({ outcome });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; metrics.dispose();
      for (const restore of undo.reverse()) try {
        restore();
      } catch { /* Worker is about to terminate. */ }
      undo.length = 0;
    },
  };
}
export const TEST_ONLY = {
};
