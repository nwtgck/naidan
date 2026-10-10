import type { GpuRequests, GpuMetadata, GpuQueueObservation } from '@/features/llama-cpp-browser/memory-diagnostics';

const readers = new WeakMap<object, () => GpuRequests | undefined>();

export function associateGpuRequests({ core, snapshot }: { core: object, snapshot: () => GpuRequests | undefined }): void {
  readers.set(core, snapshot);
}

export function readGpuRequests({ core }: { core: object }): GpuRequests | undefined {
  try {
    return readers.get(core)?.();
  } catch {
    return undefined;
  }
}

type Measurement = { open: boolean, now: () => number };
let measurement: Measurement | undefined;

/** One serialized generate request per Worker; closing also invalidates late promises. */
export function beginGpuMeasurement({ now }: { now: () => number }): () => void {
  if (measurement) measurement.open = false;
  const current: Measurement = { open: true, now };
  measurement = current;
  return () => {
    current.open = false;
    if (measurement === current) measurement = undefined;
  };
}

function safelyRead<T>({ read }: { read: () => T }): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function readMetadata({ device, adapter }: { device: GPUDevice, adapter: GPUAdapter | undefined }): GpuMetadata {
  const adapterInfo: Record<string, string> = {};
  for (const name of ['vendor', 'architecture', 'device', 'description']) {
    const value = safelyRead({ read: () => Reflect.get(adapter?.info ?? {}, name) as unknown });
    if (typeof value === 'string' && value.length > 0) adapterInfo[name] = value.slice(0, 256);
  }
  const currentFallback = safelyRead({ read: () => adapter?.info?.isFallbackAdapter });
  const fallback = typeof currentFallback === 'boolean' ? currentFallback : safelyRead({ read: () => adapter ? Reflect.get(adapter, 'isFallbackAdapter') as unknown : undefined });
  function features({ source }: { source: () => GPUSupportedFeatures | undefined }): string[] | undefined {
    return safelyRead({
      read: () => {
        const values = source();
        if (!values) return undefined;
        const result: string[] = [];
        for (const value of values) {
          if (result.length >= 128) break;
          if (typeof value === 'string') result.push(value.slice(0, 128));
        }
        return result.sort();
      },
    });
  }
  const deviceLimits: Record<string, number> = {};
  // WebIDL limit accessors are usually inherited and non-enumerable.
  for (const name of ['maxTextureDimension1D', 'maxTextureDimension2D', 'maxTextureDimension3D', 'maxTextureArrayLayers', 'maxBindGroups', 'maxBindGroupsPlusVertexBuffers', 'maxBindingsPerBindGroup', 'maxDynamicUniformBuffersPerPipelineLayout', 'maxDynamicStorageBuffersPerPipelineLayout', 'maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage', 'maxStorageBuffersPerShaderStage', 'maxStorageTexturesPerShaderStage', 'maxUniformBuffersPerShaderStage', 'maxUniformBufferBindingSize', 'maxStorageBufferBindingSize', 'minUniformBufferOffsetAlignment', 'minStorageBufferOffsetAlignment', 'maxVertexBuffers', 'maxBufferSize', 'maxVertexAttributes', 'maxVertexBufferArrayStride', 'maxInterStageShaderVariables', 'maxColorAttachments', 'maxColorAttachmentBytesPerSample', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ', 'maxComputeWorkgroupsPerDimension']) {
    const value = safelyRead({ read: () => Reflect.get(device.limits, name) as unknown });
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) deviceLimits[name] = value;
  }
  return {
    adapterInfo: Object.keys(adapterInfo).length ? adapterInfo : undefined,
    fallbackAdapter: typeof fallback === 'boolean' ? fallback : undefined,
    adapterFeatures: features({ source: () => adapter?.features }),
    deviceFeatures: features({ source: () => device.features }),
    deviceLimits: Object.keys(deviceLimits).length ? deviceLimits : undefined,
  };
}

/** A private facade preserves native receivers and never changes browser objects. */
function facade<T extends object>({ target, overrides }: { target: T, overrides: Partial<T> }): T {
  const methods = new Map<PropertyKey, { original: unknown, bound: unknown }>();
  return new Proxy(target, {
    get(_target, key) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) return Reflect.get(overrides, key);
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      let entry = methods.get(key);
      if (!entry || entry.original !== value) {
        entry = { original: value, bound: value.bind(target) }; methods.set(key, entry);
      }
      return entry.bound;
    },
    set(_target, key, value) {
      return Reflect.set(target, key, value, target);
    },
  });
}

export function createGpuRequestObserver() {
  let available = true;
  let metadata: GpuMetadata | undefined;
  const queues = new WeakMap<Measurement, GpuQueueObservation>();
  // Promise reactions cannot be detached. Bound outstanding observers across
  // request windows, including closed windows whose native waits never settle.
  const maximumOutstandingWaitObservers = 256;
  let outstandingWaitObservers = 0;
  function queueState({ current }: { current: Measurement }): GpuQueueObservation {
    let state = queues.get(current);
    if (!state) {
      state = { submitCount: 0, completionWaitCount: 0, completionWaitResolved: 0, completionWaitRejected: 0, completionWaitPending: 0, completionWaitUnobserved: 0, completionWaitDurationMs: 0, longestCompletionWaitDurationMs: 0 };
      queues.set(current, state);
    }
    return state;
  }
  function increment({ state, key }: { state: GpuQueueObservation, key: 'submitCount' | 'completionWaitCount' | 'completionWaitResolved' | 'completionWaitRejected' | 'completionWaitPending' | 'completionWaitUnobserved' }): void {
    state[key] = Math.min(Number.MAX_SAFE_INTEGER, state[key] + 1);
  }
  const totals: Omit<GpuRequests, 'metadata' | 'queue'> = { bufferCount: 0, bufferBytes: 0, writeCount: 0, writeBytes: 0, largestWriteBytes: 0, writesAtLeast4MiB: 0 };
  function observe({ update }: { update: () => void }): void {
    if (!available) return;
    try {
      update();
      if (Object.values(totals).some(value => !Number.isSafeInteger(value) || value < 0)) available = false;
    } catch {
      available = false;
    }
  }
  return {
    snapshot(): GpuRequests | undefined {
      if (!available) return undefined;
      const queue = measurement?.open ? { ...queueState({ current: measurement }) } : undefined;
      return { ...totals, ...(metadata ? { metadata: structuredClone(metadata) } : {}), ...(queue ? { queue } : {}) };
    },
    wrapDevice({ device, adapter }: { device: GPUDevice, adapter?: GPUAdapter }): GPUDevice {
      metadata = safelyRead({ read: () => readMetadata({ device, adapter }) });
      const queue = device.queue;
      return facade({
        target: device,
        overrides: {
          createBuffer(descriptor) {
            const buffer = device.createBuffer(descriptor);
            // Read the returned object's size, never evaluate descriptor getters again.
            observe({
              update() {
                totals.bufferCount++; totals.bufferBytes += buffer.size;
              },
            });
            return buffer;
          },
          queue: facade({
            target: queue,
            overrides: {
              submit(...args: Parameters<GPUQueue['submit']>) {
                const result = queue.submit(...args);
                const current = measurement;
                if (current?.open) increment({ state: queueState({ current }), key: 'submitCount' });
                return result;
              },
              onSubmittedWorkDone() {
                const current = measurement;
                const started = current?.open && outstandingWaitObservers < maximumOutstandingWaitObservers ? safelyRead({ read: current.now }) : undefined;
                const result = queue.onSubmittedWorkDone();
                if (!current?.open) return result;
                // Return the original promise, with native receiver and rejection unchanged.
                // Side observers never fence, await, or feed timing back into inference.
                const state = queueState({ current });
                increment({ state, key: 'completionWaitCount' });
                if (outstandingWaitObservers >= maximumOutstandingWaitObservers) {
                  increment({ state, key: 'completionWaitUnobserved' }); return result;
                }
                outstandingWaitObservers++;
                increment({ state, key: 'completionWaitPending' });
                function settled({ outcome }: { outcome: 'completionWaitResolved' | 'completionWaitRejected' }): void {
                  outstandingWaitObservers--;
                  if (!current?.open) return;
                  safelyRead({
                    read: () => {
                      increment({ state, key: outcome });
                      state.completionWaitPending = Math.max(0, state.completionWaitPending - 1);
                      const ended = safelyRead({ read: current.now });
                      const elapsed = started === undefined || ended === undefined ? NaN : ended - started;
                      const sum = (state.completionWaitDurationMs ?? NaN) + elapsed;
                      if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(sum)) {
                        state.completionWaitDurationMs = undefined; state.longestCompletionWaitDurationMs = undefined;
                      } else {
                        state.completionWaitDurationMs = sum;
                        state.longestCompletionWaitDurationMs = Math.max(state.longestCompletionWaitDurationMs ?? 0, elapsed);
                      }
                    },
                  });
                }
                try {
                  void result.then(() => settled({ outcome: 'completionWaitResolved' }), () => settled({ outcome: 'completionWaitRejected' }));
                } catch {
                  outstandingWaitObservers--;
                  state.completionWaitPending--;
                  increment({ state, key: 'completionWaitUnobserved' });
                }
                return result;
              },
              writeBuffer(...args: Parameters<GPUQueue['writeBuffer']>) {
                const result = queue.writeBuffer(...args);
                // This is call traffic, not GPU completion or successful allocation.
                observe({
                  update() {
                    const data = args[2];
                    const unit = ArrayBuffer.isView(data) && 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
                    const bytes = args[4] === undefined ? data.byteLength - (args[3] ?? 0) * unit : args[4] * unit;
                    totals.writeCount++; totals.writeBytes += bytes;
                    totals.largestWriteBytes = Math.max(totals.largestWriteBytes, bytes);
                    if (bytes >= 4 * 1024 * 1024) totals.writesAtLeast4MiB++;
                  },
                });
                return result;
              },
            },
          }),
        },
      });
    },
  };
}

export const TEST_ONLY = {
};
