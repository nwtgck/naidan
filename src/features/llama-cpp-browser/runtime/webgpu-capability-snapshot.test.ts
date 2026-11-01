import { afterEach, expect, it, vi } from 'vitest';
import { subscribeDiagnostics } from '@/features/llama-cpp-browser/debug-log';
import { memoryDiagnosticSchema, type GpuCapabilitySnapshot } from '@/features/llama-cpp-browser/memory-diagnostics';
import { memoryDiagnosticsSchema } from '@/features/llama-cpp-browser/performance/memory-schema';
import { beginGpuMeasurement, createGpuRequestObserver } from './webgpu-request-diagnostics';
import { createCoreWebGpuNavigator } from './webgpu-dispatch';

function deviceFixture(): GPUDevice {
  return { queue: {}, limits: {}, features: new Set(), createBuffer: vi.fn() } as unknown as GPUDevice;
}

function capture({ adapter, gpu }: { adapter: unknown, gpu: unknown }): GpuCapabilitySnapshot {
  const observer = createGpuRequestObserver();
  observer.wrapDevice({ device: deviceFixture(), adapter: adapter as GPUAdapter | undefined, gpu: gpu as GPU | undefined });
  const value = observer.snapshot()?.metadata?.capabilitySnapshot;
  if (!value) {
    throw new Error('Expected an enabled capability snapshot');
  }
  return value;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([false, true])('records the exact WGSL packed-dot membership %s independently of device features', supported => {
  const now = vi.fn(() => 123);
  using _measurement = { [Symbol.dispose]: beginGpuMeasurement({ now }) };
  const value = capture({
    adapter: { info: { vendor: '' }, features: new Set(['packed_4x8_integer_dot_product']) },
    gpu: { wgslLanguageFeatures: new Set(supported ? ['packed_4x8_integer_dot_product'] : []) },
  });
  expect(value).toEqual({
    capture: 'device-created',
    adapterVendor: { status: 'available', value: '', length: 0, truncated: false },
    wgslLanguageFeatures: { status: 'available', packed_4x8_integer_dot_product: supported },
  });
  expect(now).not.toHaveBeenCalled();
});

it.each([
  { label: 'missing adapter', adapter: undefined, reason: 'adapter-unavailable' },
  { label: 'missing info', adapter: {}, reason: 'info-unavailable' },
  { label: 'missing vendor', adapter: { info: {} }, reason: 'vendor-unavailable' },
  { label: 'invalid vendor', adapter: { info: { vendor: 42 } }, reason: 'invalid-type' },
  {
    label: 'throwing info',
    adapter: {
      get info() {
        throw new Error('unavailable');
      },
    },
    reason: 'read-failed',
  },
  {
    label: 'throwing vendor',
    adapter: {
      info: {
        get vendor() {
          throw new Error('unavailable');
        },
      },
    },
    reason: 'read-failed',
  },
])('distinguishes $label from an exposed empty vendor', ({ adapter, reason }) => {
  using _measurement = { [Symbol.dispose]: beginGpuMeasurement({ now: () => 0 }) };
  expect(capture({ adapter, gpu: undefined }).adapterVendor).toEqual({ status: 'unavailable', reason });
});

it('preserves vendor casing and whitespace and records a bounded value with its original length', () => {
  using _measurement = { [Symbol.dispose]: beginGpuMeasurement({ now: () => 0 }) };
  expect(capture({ adapter: { info: { vendor: ' Intel ' } }, gpu: undefined }).adapterVendor)
    .toEqual({ status: 'available', value: ' Intel ', length: 7, truncated: false });
  expect(capture({ adapter: { info: { vendor: 'v'.repeat(300) } }, gpu: undefined }).adapterVendor)
    .toEqual({ status: 'available', value: 'v'.repeat(256), length: 300, truncated: true });
});

it.each([
  { label: 'missing GPU', gpu: undefined, reason: 'gpu-unavailable' },
  { label: 'missing property', gpu: {}, reason: 'property-unavailable' },
  { label: 'undefined value', gpu: { wgslLanguageFeatures: undefined }, reason: 'invalid-value' },
  { label: 'missing has', gpu: { wgslLanguageFeatures: {} }, reason: 'invalid-value' },
  {
    label: 'nonboolean has result',
    gpu: {
      wgslLanguageFeatures: {
        has() {
          return 'yes';
        },
      },
    },
    reason: 'invalid-value',
  },
  {
    label: 'throwing property',
    gpu: {
      get wgslLanguageFeatures() {
        throw new Error('unavailable');
      },
    },
    reason: 'read-failed',
  },
  {
    label: 'throwing has',
    gpu: {
      wgslLanguageFeatures: {
        has() {
          throw new Error('unavailable');
        },
      },
    },
    reason: 'read-failed',
  },
])('keeps $label unknown instead of reporting unsupported', ({ gpu, reason }) => {
  using _measurement = { [Symbol.dispose]: beginGpuMeasurement({ now: () => 0 }) };
  expect(capture({ adapter: undefined, gpu }).wgslLanguageFeatures).toEqual({ status: 'unavailable', reason });
});

it('uses the original selected GPU once when debug is enabled on a retained runtime and omits it afterwards', async () => {
  const raw = deviceFixture();
  const vendor = vi.fn(() => 'intel');
  const features = new Set(['packed_4x8_integer_dot_product']);
  const membership = vi.spyOn(features, 'has');
  const readFeatures = vi.fn(() => features);
  const adapter = {
    info: {
      get vendor() {
        return vendor();
      },
    },
    requestDevice: vi.fn(async () => raw),
  };
  const gpu = {
    requestAdapter: vi.fn(async () => adapter),
    get wgslLanguageFeatures() {
      return readFeatures();
    },
  };
  vi.stubGlobal('navigator', {
    get gpu() {
      throw new Error('Do not read another navigator');
    },
  });
  const observer = createGpuRequestObserver();
  const navigator = createCoreWebGpuNavigator({ navigator: { gpu } as unknown as Pick<Navigator, 'gpu'>, report() {}, observeDevice: observer.wrapDevice })!;
  const selected = await navigator.gpu.requestAdapter();
  await selected!.requestDevice();
  const initialVendorReads = vendor.mock.calls.length;
  expect(observer.snapshot()!.metadata!.capabilitySnapshot).toBeUndefined();
  expect(observer.snapshot()!.metadata!.capabilitySnapshot).toBeUndefined();
  expect(vendor).toHaveBeenCalledTimes(initialVendorReads);
  expect(readFeatures).not.toHaveBeenCalled();
  {
    using _subscription = { [Symbol.dispose]: subscribeDiagnostics({ debug: 'on', listener() {} }) };
    const snapshot = observer.snapshot()!.metadata!.capabilitySnapshot!;
    expect(snapshot).toEqual({
      capture: 'retained-device',
      adapterVendor: { status: 'available', value: 'intel', length: 5, truncated: false },
      wgslLanguageFeatures: { status: 'available', packed_4x8_integer_dot_product: true },
    });
    if (snapshot.adapterVendor.status === 'available') {
      snapshot.adapterVendor.value = 'mutated';
    }
    expect(observer.snapshot()!.metadata!.capabilitySnapshot!.adapterVendor).toMatchObject({ value: 'intel' });
    expect(readFeatures).toHaveBeenCalledTimes(1);
    expect(membership).toHaveBeenCalledExactlyOnceWith('packed_4x8_integer_dot_product');
    expect(membership.mock.contexts[0]).toBe(features);
  }
  expect(observer.snapshot()!.metadata!.capabilitySnapshot).toBeUndefined();
  expect(readFeatures).toHaveBeenCalledTimes(1);
  expect(vendor).toHaveBeenCalledTimes(initialVendorReads + 1);
  expect(gpu.requestAdapter).toHaveBeenCalledTimes(1);
  expect(adapter.requestDevice).toHaveBeenCalledTimes(1);
});

it('accepts old snapshots and roundtrips bounded capability states while rejecting malformed fields', () => {
  const sample = { kind: 'naidan-llama-cpp-memory', instanceId: 'fixture', profile: 'webgpu-wasm64-jspi', checkpoint: 'runtime-ready', timestamp: 0, capacityBytes: 0 };
  expect(memoryDiagnosticSchema.safeParse(sample).success).toBe(true);
  const requests = createGpuRequestObserver().snapshot()!;
  using _measurement = { [Symbol.dispose]: beginGpuMeasurement({ now: () => 0 }) };
  const capabilitySnapshot = capture({ adapter: { info: { vendor: '' } }, gpu: {} });
  const diagnostics = { samples: [{ ...sample, gpuRequests: { ...requests, metadata: { capabilitySnapshot } } }], droppedSamples: 0, nativeAllocations: [], droppedNativeAllocations: 0, nativeSettings: [], droppedNativeSettings: 0 };
  expect(memoryDiagnosticsSchema.parse(JSON.parse(JSON.stringify(diagnostics)))).toEqual(diagnostics);
  const withSnapshot = ({ value }: { value: unknown }) => ({ ...sample, gpuRequests: { ...requests, metadata: { capabilitySnapshot: value } } });
  for (const value of [
    { ...capabilitySnapshot, adapterVendor: { status: 'available', value: 'x'.repeat(257), length: 257, truncated: true } },
    { ...capabilitySnapshot, wgslLanguageFeatures: { status: 'available' } },
    { ...capabilitySnapshot, wgslLanguageFeatures: { status: 'available', packed_4x8_integer_dot_product: 'false' } },
    { ...capabilitySnapshot, wgslLanguageFeatures: { status: 'unavailable', reason: 'invented' } },
    { ...capabilitySnapshot, prompt: 'not metadata' },
  ]) {
    expect(memoryDiagnosticSchema.safeParse(withSnapshot({ value })).success).toBe(false);
  }
});
