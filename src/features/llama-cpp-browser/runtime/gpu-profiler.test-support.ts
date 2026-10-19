/* eslint-disable local-rules-named-args/require-named-args -- WebGPU fixture methods reproduce the browser API positional signatures and receiver semantics. */
import { beginGpuProfileMeasurement, createGpuProfileObserver } from './gpu-profiler';

export function createMeasurementFixture() {
  const scope = beginGpuProfileMeasurement();
  return {
    ...scope,
    [Symbol.dispose]() {
      scope.finish();
    },
  };
}

/** A strict-receiver WebGPU fixture. Only the application issues GPU work;
 * readback calls and pass/dispatch counts expose accidental observer work. */
export function createGpuProfileFixture() {
  const calls = { buffers: 0, passes: 0, dispatches: 0, resolves: 0, copies: 0, maps: 0, reads: 0, submits: 0 };
  const storage = new WeakMap<GPUBuffer, ArrayBuffer>();
  const timestamps = new WeakMap<GPUQuerySet, bigint[]>();
  const rawBuffers: GPUBuffer[] = [];
  let frozenBuffer = false;
  const nativeFailure = new Error('native read failure');
  let readFailure = false;
  function brand({ received, expected }: { received: unknown, expected: unknown }): void {
    if (received !== expected) {
      throw new Error('illegal native receiver');
    }
  }
  const native = {
    label: 'fixture device',
    createBuffer(descriptor: GPUBufferDescriptor) {
      brand({ received: this, expected: native });
      calls.buffers++;
      const data = new ArrayBuffer(Number(descriptor.size));
      const raw = {
        size: Number(descriptor.size),
        usage: descriptor.usage,
        async mapAsync() {
          brand({ received: this, expected: raw });
          calls.maps++;
        },
        getMappedRange(offset = 0, size = data.byteLength - offset) {
          brand({ received: this, expected: raw });
          calls.reads++;
          if (readFailure) {
            throw nativeFailure;
          }
          return data.slice(offset, offset + size);
        },
        unmap() {
          brand({ received: this, expected: raw });
        },
      };
      const buffer = raw as unknown as GPUBuffer;
      storage.set(buffer, data);
      rawBuffers.push(buffer);
      if (frozenBuffer) {
        Object.freeze(buffer);
      }
      return buffer;
    },
    createCommandEncoder() {
      brand({ received: this, expected: native });
      const encoder = {
        beginComputePass(_descriptor?: GPUComputePassDescriptor) {
          brand({ received: this, expected: encoder });
          calls.passes++;
          const pass = {
            setPipeline(_pipeline: GPUComputePipeline) {
              brand({ received: this, expected: pass });
            },
            dispatchWorkgroups(_x: number, _y?: number, _z?: number) {
              brand({ received: this, expected: pass });
              calls.dispatches++;
            },
            dispatchWorkgroupsIndirect(_buffer: GPUBuffer, _offset: number) {
              brand({ received: this, expected: pass });
              calls.dispatches++;
            },
            end() {
              brand({ received: this, expected: pass });
            },
          };
          return pass as unknown as GPUComputePassEncoder;
        },
        resolveQuerySet(query: GPUQuerySet, first: number, count: number, target: GPUBuffer, offset: number) {
          brand({ received: this, expected: encoder });
          calls.resolves++;
          const view = new DataView(storage.get(target)!);
          for (let i = 0; i < count; i++) {
            view.setBigUint64(offset + i * 8, timestamps.get(query)?.[first + i] ?? 0n, true);
          }
        },
        copyBufferToBuffer(...args: [GPUBuffer, GPUBuffer, number?] | [GPUBuffer, number, GPUBuffer, number, number?]) {
          brand({ received: this, expected: encoder });
          calls.copies++;
          const source = args[0];
          const from = typeof args[1] === 'number' ? args[1] : 0;
          const target = typeof args[1] === 'number' ? args[2] as GPUBuffer : args[1];
          const to = typeof args[1] === 'number' ? args[3] ?? 0 : 0;
          const size = (typeof args[1] === 'number' ? args[4] : args[2] as number | undefined) ?? source.size - from;
          new Uint8Array(storage.get(target)!).set(new Uint8Array(storage.get(source)!, from, size), to);
        },
        finish() {
          brand({ received: this, expected: encoder });
          return {} as GPUCommandBuffer;
        },
      };
      return encoder as unknown as GPUCommandEncoder;
    },
  };
  const observer = createGpuProfileObserver();
  const device = observer.wrapDevice({ device: native as unknown as GPUDevice });
  const encoder = device.createCommandEncoder();
  function query({ values = [1000000n, 3000000n] }: { values?: bigint[] } = {}): GPUQuerySet {
    const result = {} as GPUQuerySet;
    timestamps.set(result, values);
    return result;
  }
  function pass({ querySet, start = 0, end = 1, shader = 'mul_mat_vec_q4_K_f32', dispatches = 1 }: {
    querySet: GPUQuerySet, start?: number, end?: number, shader?: string, dispatches?: number,
  }): GPUComputePassEncoder {
    const result = encoder.beginComputePass({ timestampWrites: { querySet, beginningOfPassWriteIndex: start, endOfPassWriteIndex: end } });
    result.setPipeline({ label: shader } as GPUComputePipeline);
    for (let i = 0; i < dispatches; i++) {
      result.dispatchWorkgroups(8, 2);
    }
    return result;
  }
  function resolve({ querySet, first = 0, count = 2 }: { querySet: GPUQuerySet, first?: number, count?: number }): GPUBuffer {
    const buffer = device.createBuffer({ size: count * 8, usage: 0x0200 | 0x0004 });
    encoder.resolveQuerySet(querySet, first, count, buffer, 0);
    return buffer;
  }
  function hostBuffer({ size = 16 }: { size?: number } = {}): GPUBuffer {
    return device.createBuffer({ size, usage: 0x0001 | 0x0008 });
  }
  function read({ querySet }: { querySet: GPUQuerySet }): ArrayBuffer {
    const source = resolve({ querySet });
    const target = hostBuffer();
    encoder.copyBufferToBuffer(source, 0, target, 0, 16);
    return target.getMappedRange();
  }
  return {
    device,
    encoder,
    query,
    pass,
    resolve,
    hostBuffer,
    read,
    calls,
    rawBuffers,
    nativeFailure,
    freezeBuffers() {
      frozenBuffer = true;
    },
    failReads() {
      readFailure = true;
    },
    [Symbol.dispose]() { /* The fixture owns no native resources or global hooks. */ },
  };
}
