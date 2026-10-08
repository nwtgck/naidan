import type { GpuRequests } from '@/features/llama-cpp-browser/memory-diagnostics';

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
  const totals: GpuRequests = { bufferCount: 0, bufferBytes: 0, writeCount: 0, writeBytes: 0, largestWriteBytes: 0, writesAtLeast4MiB: 0 };
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
      return available ? { ...totals } : undefined;
    },
    wrapDevice({ device }: { device: GPUDevice }): GPUDevice {
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
