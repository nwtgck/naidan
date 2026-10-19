import { gpuProfileSchema, maximumGpuProfileGroups, maximumPendingGpuProfilePasses, type GpuProfile, type GpuProfilePhase, type GpuProfileRow } from '@/features/llama-cpp-browser/performance/gpu-profile-schema';

type Measurement = {
  open: boolean,
  phase: GpuProfilePhase,
  result: GpuProfile,
  groups: Map<string, GpuProfileRow>,
};
type Sample = {
  owner: Measurement,
  phase: GpuProfilePhase,
  shader: string,
  grid?: [number, number, number],
  dispatches: number,
  ambiguous: boolean,
  settled: boolean,
  start?: bigint,
  end?: bigint,
};
type Timestamp = { sample: Sample, point: 'start' | 'end' };
let measurement: Measurement | undefined;

/** The worker serializes requests. Encoded samples retain their original owner,
 * so a late readback can never be attributed to the next request or phase. */
export function beginGpuProfileMeasurement() {
  if (measurement?.open) {
    measurement.result.instrumentationErrors++;
    measurement.open = false;
  }
  const current: Measurement = {
    open: true,
    phase: 'other',
    groups: new Map(),
    result: {
      version: 1,
      source: 'webgpu-pass-timestamps',
      status: 'unavailable',
      observedPasses: 0,
      measuredPasses: 0,
      pendingPasses: 0,
      invalidPasses: 0,
      droppedPasses: 0,
      ungroupedPasses: 0,
      ambiguousPasses: 0,
      instrumentationErrors: 0,
      zeroDurationPasses: 0,
      totalGpuMs: 0,
      precision: 'browser-defined',
      rows: [],
    },
  };
  measurement = current;
  let result: GpuProfile | undefined;
  return {
    enter({ phase }: { phase: GpuProfilePhase }): void {
      if (current.open) {
        current.phase = phase;
      }
    },
    finish(): GpuProfile {
      if (result) {
        return result;
      }
      current.open = false;
      if (measurement === current) {
        measurement = undefined;
      }
      const state = current.result;
      const partial = state.pendingPasses + state.invalidPasses + state.droppedPasses + state.ungroupedPasses + state.ambiguousPasses + state.instrumentationErrors > 0;
      result = gpuProfileSchema.parse({
        ...state,
        status: state.measuredPasses === 0 ? 'unavailable' : partial ? 'partial' : 'complete',
        rows: [...current.groups.values()].map(row => ({ ...row, meanPassMs: row.totalGpuMs / row.passes })),
      });
      current.groups.clear();
      return result;
    },
  };
}

export type GpuProfileMeasurement = ReturnType<typeof beginGpuProfileMeasurement>;

function facade<T extends object>({ target, overrides }: { target: T, overrides: Partial<T> }): T {
  const methods = new Map<PropertyKey, { original: unknown, bound: unknown }>();
  return new Proxy(target, {
    get(_target, key) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        return Reflect.get(overrides, key);
      }
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') {
        return value;
      }
      let entry = methods.get(key);
      if (!entry || entry.original !== value) {
        entry = { original: value, bound: value.bind(target) };
        methods.set(key, entry);
      }
      return entry.bound;
    },
    set(_target, key, value) {
      return Reflect.set(target, key, value, target);
    },
  });
}

function observe({ owner = measurement, run }: { owner?: Measurement, run: () => void }): void {
  try {
    run();
  } catch {
    if (owner?.open) {
      owner.result.instrumentationErrors++;
    }
  }
}

function completeSample({ sample }: { sample: Sample }): void {
  if (sample.settled || !sample.owner.open || sample.start === undefined || sample.end === undefined) {
    return;
  }
  sample.settled = true;
  const { result, groups } = sample.owner;
  result.pendingPasses--;
  const ns = sample.end - sample.start;
  if (ns < 0n || ns > BigInt(Number.MAX_SAFE_INTEGER) || sample.dispatches === 0) {
    result.invalidPasses++;
    return;
  }
  const elapsedMs = Number(ns) / 1000000;
  result.measuredPasses++;
  result.totalGpuMs += elapsedMs;
  result.zeroDurationPasses += Number(ns === 0n);
  result.ambiguousPasses += Number(sample.ambiguous);
  const shader = sample.ambiguous ? '[multiple-pipelines]' : sample.shader;
  const key = JSON.stringify([sample.phase, shader, sample.grid]);
  let row = groups.get(key);
  if (!row) {
    if (groups.size >= maximumGpuProfileGroups) {
      result.ungroupedPasses++;
      return;
    }
    row = { phase: sample.phase, shader, workgroups: sample.grid, passes: 0, dispatches: 0, multiDispatchPasses: 0, totalGpuMs: 0, meanPassMs: 0, minimumPassMs: elapsedMs, maximumPassMs: elapsedMs, zeroDurationPasses: 0 };
    groups.set(key, row);
  }
  row.passes++;
  row.dispatches += sample.dispatches;
  row.multiDispatchPasses += Number(sample.dispatches > 1);
  row.totalGpuMs += elapsedMs;
  row.minimumPassMs = Math.min(row.minimumPassMs, elapsedMs);
  row.maximumPassMs = Math.max(row.maximumPassMs, elapsedMs);
  row.zeroDurationPasses += Number(ns === 0n);
}

/** Observe public WebGPU calls made by the upstream profiling build, not private
 * ggml structures or its destructor log. Only diagnostic-owned MAP_READ buffers
 * get an own getMappedRange method. Their identity and native WebIDL brand stay
 * intact; browser prototypes and other devices are never modified. */
export function createGpuProfileObserver() {
  const queries = new WeakMap<GPUQuerySet, Map<number, Timestamp>>();
  const buffers = new WeakMap<GPUBuffer, Map<number, Timestamp>>();
  const maximumTimestamps = maximumPendingGpuProfilePasses * 2;

  function copyMetadata({ source, sourceOffset, destination, destinationOffset, size }: {
    source?: Map<number, Timestamp>, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size: number,
  }): void {
    const old = buffers.get(destination);
    const entries = [...(source ?? [])].filter(([offset]) => offset >= sourceOffset && offset + 8 <= sourceOffset + size);
    if (!old && entries.length === 0) {
      return;
    }
    const target = old ?? new Map<number, Timestamp>();
    // Erase overwritten ranges even when their new contents are not timestamps.
    for (const offset of target.keys()) {
      if (offset < destinationOffset + size && offset + 8 > destinationOffset) {
        target.delete(offset);
      }
    }
    for (const [offset, timestamp] of entries) {
      if (target.size >= maximumTimestamps) {
        throw new Error('GPU timestamp metadata capacity exceeded');
      }
      target.set(destinationOffset + offset - sourceOffset, timestamp);
    }
    buffers.set(destination, target);
  }

  function readback({ buffer, offset, range }: { buffer: GPUBuffer, offset: number, range: ArrayBuffer }): void {
    const positions = buffers.get(buffer);
    if (!positions) {
      return;
    }
    const view = new DataView(range);
    for (const [at, timestamp] of positions) {
      if (at < offset || at + 8 > offset + range.byteLength) {
        continue;
      }
      positions.delete(at);
      const sample = timestamp.sample;
      if (!sample.owner.open || sample.settled) {
        continue;
      }
      // Browser timestamp-query values are nanoseconds. Do not read this mapped
      // range again, retain it after unmap, or create another native readback.
      sample[timestamp.point] = view.getBigUint64(at - offset, true);
      completeSample({ sample });
    }
  }

  function wrapEncoder({ encoder }: { encoder: GPUCommandEncoder }): GPUCommandEncoder {
    return facade({
      target: encoder,
      overrides: {
        beginComputePass(descriptor) {
          const pass = encoder.beginComputePass(descriptor);
          let sample: Sample | undefined;
          const owner = measurement;
          observe({
            owner,
            run() {
              // Native bridge descriptors are plain data. Do not evaluate
              // application accessors a second time after WebIDL conversion.
              const property = descriptor && Object.getOwnPropertyDescriptor(descriptor, 'timestampWrites');
              if (!property || !('value' in property)) {
                return;
              }
              const writes = property.value as GPUComputePassTimestampWrites | undefined;
              if (!writes) {
                return;
              }
              const slots = queries.get(writes.querySet) ?? new Map<number, Timestamp>();
              const start = writes.beginningOfPassWriteIndex;
              const end = writes.endOfPassWriteIndex;
              // Reusing query indices outside an active request invalidates old
              // associations too; query slots are not request identities.
              if (start !== undefined) {
                slots.delete(start);
              }
              if (end !== undefined) {
                slots.delete(end);
              }
              queries.set(writes.querySet, slots);
              if (!owner?.open) {
                return;
              }
              owner.result.observedPasses++;
              if (start === undefined || end === undefined || start === end) {
                owner.result.invalidPasses++;
                return;
              }
              if (owner.result.pendingPasses >= maximumPendingGpuProfilePasses || slots.size + 2 > maximumTimestamps) {
                owner.result.droppedPasses++;
                return;
              }
              sample = { owner, phase: owner.phase, shader: '[unlabelled]', dispatches: 0, ambiguous: false, settled: false };
              owner.result.pendingPasses++;
              slots.set(start, { sample, point: 'start' });
              slots.set(end, { sample, point: 'end' });
            },
          });
          if (!sample) {
            return pass;
          }
          const captured = sample;
          let shader = '[unlabelled]';
          return facade({
            target: pass,
            overrides: {
              setPipeline(pipeline) {
                pass.setPipeline(pipeline);
                observe({
                  owner,
                  run() {
                    shader = pipeline.label.slice(0, 512) || '[unlabelled]';
                  },
                });
              },
              dispatchWorkgroups(...args: Parameters<GPUComputePassEncoder['dispatchWorkgroups']>) {
                pass.dispatchWorkgroups(...args);
                observe({
                  owner,
                  run() {
                    if (captured.dispatches > 0 && captured.shader !== shader) {
                      captured.ambiguous = true;
                    }
                    captured.shader = shader;
                    captured.dispatches++;
                    captured.grid = captured.dispatches === 1 ? [args[0], args[1] ?? 1, args[2] ?? 1] : undefined;
                  },
                });
              },
              dispatchWorkgroupsIndirect(...args: Parameters<GPUComputePassEncoder['dispatchWorkgroupsIndirect']>) {
                pass.dispatchWorkgroupsIndirect(...args);
                observe({
                  owner,
                  run() {
                    if (captured.dispatches > 0 && captured.shader !== shader) {
                      captured.ambiguous = true;
                    }
                    captured.shader = shader;
                    captured.dispatches++;
                    captured.grid = undefined;
                  },
                });
              },
            },
          });
        },
        resolveQuerySet(...args: Parameters<GPUCommandEncoder['resolveQuerySet']>) {
          encoder.resolveQuerySet(...args);
          observe({
            run() {
              const [querySet, first, count, target, offset] = args;
              const timestamps = new Map<number, Timestamp>();
              for (const [index, timestamp] of queries.get(querySet) ?? []) {
                if (index >= first && index < first + count) {
                  timestamps.set((index - first) * 8, timestamp);
                }
              }
              copyMetadata({ source: timestamps, sourceOffset: 0, destination: target, destinationOffset: offset, size: count * 8 });
            },
          });
        },
        copyBufferToBuffer(...args: [GPUBuffer, GPUBuffer, GPUSize64?] | [GPUBuffer, GPUSize64, GPUBuffer, GPUSize64, GPUSize64?]) {
          Reflect.apply(encoder.copyBufferToBuffer, encoder, args);
          observe({
            run() {
              const source = args[0];
              const from = typeof args[1] === 'number' ? args[1] : 0;
              const target = typeof args[1] === 'number' ? args[2] as GPUBuffer : args[1];
              const to = typeof args[1] === 'number' ? args[3] ?? 0 : 0;
              const size = (typeof args[1] === 'number' ? args[4] : args[2] as number | undefined) ?? source.size - from;
              copyMetadata({ source: buffers.get(source), sourceOffset: from, destination: target, destinationOffset: to, size });
            },
          });
        },
      },
    });
  }
  return {
    wrapDevice({ device }: { device: GPUDevice }): GPUDevice {
      return facade({
        target: device,
        overrides: {
          createCommandEncoder(...args: Parameters<GPUDevice['createCommandEncoder']>) {
            const encoder = device.createCommandEncoder(...args);
            return wrapEncoder({ encoder });
          },
          createBuffer(...args: Parameters<GPUDevice['createBuffer']>) {
            const buffer = device.createBuffer(...args);
            observe({
              run() {
                // MAP_READ is a stable WebGPU flag (0x0001). Reading buffer.usage
                // avoids evaluating descriptor getters again. Never wrap weights.
                if (!(buffer.usage & 0x0001)) {
                  return;
                }
                const getMappedRange = buffer.getMappedRange.bind(buffer);
                Object.defineProperty(buffer, 'getMappedRange', {
                  configurable: true,
                  writable: true,
                  value(...args: Parameters<GPUBuffer['getMappedRange']>): ArrayBuffer {
                    const range = getMappedRange(...args);
                    observe({
                      run() {
                        readback({ buffer, offset: args[0] ?? 0, range });
                      },
                    });
                    return range;
                  },
                });
              },
            });
            return buffer;
          },
        },
      });
    },
  };
}

export const TEST_ONLY = {
};
