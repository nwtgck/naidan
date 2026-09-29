import { afterEach, expect, it, vi } from 'vitest';
import { installImageWebGpu } from './webgpu';
import { observeImageGpu } from './gpu-diagnostics';

const code = `\
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) grid: vec3<u32>) {
  let index = gid.x + grid.x * 64u * gid.y;
}
`;
function fixture() {
  const draws: { counts: number[], constants: Record<string, number> | undefined }[] = [];
  let current: GPUComputePipelineDescriptor | undefined;
  const descriptors = new WeakMap<GPUComputePipeline, GPUComputePipelineDescriptor>();
  const pass = {
    setPipeline(pipeline: GPUComputePipeline) {
      current = descriptors.get(pipeline);
    },
    dispatchWorkgroups(x: number, y: number | undefined, z: number | undefined) {
      if (x > 65535) throw new Error('Unadapted dispatch exceeds device limit');
      draws.push({ counts: [x, y ?? 1, z ?? 1], constants: current?.compute.constants });
    },
  };
  const device = Object.assign(new EventTarget(), {
    limits: { maxComputeWorkgroupsPerDimension: 65535 }, features: new Set(), lost: new Promise(() => {}),
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn((descriptor: GPUComputePipelineDescriptor) => {
      const pipeline = {} as GPUComputePipeline; descriptors.set(pipeline, descriptor); return pipeline;
    }),
    createCommandEncoder: vi.fn(() => ({ beginComputePass: () => pass })),
    createBuffer: vi.fn(), createComputePipelineAsync: vi.fn(), popErrorScope: vi.fn(),
    queue: { writeBuffer: vi.fn(), submit: vi.fn(), onSubmittedWorkDone: vi.fn() },
  });
  const adapter = { requestDevice: vi.fn(async () => device) };
  const gpu = { requestAdapter: vi.fn(async () => adapter) };
  vi.stubGlobal('navigator', { gpu });
  return { gpu: gpu as unknown as GPU, adapter, device, draws, original: gpu.requestAdapter, originalDevice: adapter.requestDevice };
}
afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(['off', 'on'] as const)('splits 65536 through the published factory acquisition path with debug=%s', async debug => {
  const f = fixture(), emit = vi.fn();
  const observation = observeImageGpu({ emit, debug });
  const boundary = installImageWebGpu({ gpu: f.gpu, emit });
  try {
    expect(f.original).not.toHaveBeenCalled(); expect(f.originalDevice).not.toHaveBeenCalled();
    // Like the published image factory: read the Worker's navigator, not a
    // directly injected facade or a TEST_ONLY adapter entry point.
    const options = { powerPreference: 'high-performance' as const };
    const descriptor = { requiredLimits: { maxComputeWorkgroupsPerDimension: 65535 } };
    const device = await (await navigator.gpu.requestAdapter(options))!.requestDevice(descriptor);
    expect(f.original).toHaveBeenCalledOnce(); expect(f.original).toHaveBeenCalledWith(options);
    expect(f.originalDevice).toHaveBeenCalledOnce(); expect(f.originalDevice).toHaveBeenCalledWith(descriptor);
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }) } });
    const pass = device.createCommandEncoder().beginComputePass(); pass.setPipeline(pipeline);
    pass.dispatchWorkgroups(65536, 1, 1); pass.dispatchWorkgroups(9, 1, 1);
    expect(f.draws.map(draw => draw.counts)).toEqual([[65535, 1, 1], [1, 1, 1], [9, 1, 1]]);
    expect(f.draws[1]?.constants).toMatchObject({ naidan_dispatch_offset_x: 65535, naidan_dispatch_grid_x: 65536 });
    expect(f.draws[2]?.constants).toBeUndefined();
    expect(device.limits.maxComputeWorkgroupsPerDimension).toBe(65535);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'gpu', fields: { axis: 'x', count: 65536, limit: 65535, chunks: 2 } }));
  } finally {
    boundary.dispose(); boundary.dispose(); observation.dispose();
  }
  expect(f.gpu.requestAdapter).toBe(f.original); expect(f.adapter.requestDevice).toBe(f.originalDevice);
});
it('refuses to start with a non-configurable acquisition method rather than running unprotected', () => {
  const f = fixture();
  Object.defineProperty(f.gpu, 'requestAdapter', { value: f.original, configurable: false, writable: false });
  expect(() => installImageWebGpu({ gpu: f.gpu, emit: vi.fn() })).toThrow();
  expect(f.original).not.toHaveBeenCalled();
});
it('propagates adapter denial and exceptions without retrying or changing the device', async () => {
  const f = fixture(), boundary = installImageWebGpu({ gpu: f.gpu, emit: vi.fn() });
  const error = new Error('Adapter denied'); f.original.mockRejectedValueOnce(error);
  try {
    await expect(f.gpu.requestAdapter()).rejects.toBe(error);
  } finally {
    boundary.dispose();
  }
  expect(f.original).toHaveBeenCalledOnce(); expect(f.gpu.requestAdapter).toBe(f.original);
});
it('restores inherited acquisition methods without leaving an own property behind', () => {
  const f = fixture(); const gpu = Object.create(f.gpu) as GPU;
  expect(Object.hasOwn(gpu, 'requestAdapter')).toBe(false);
  const boundary = installImageWebGpu({ gpu, emit: vi.fn() });
  expect(Object.hasOwn(gpu, 'requestAdapter')).toBe(true);
  boundary.dispose(); expect(Object.hasOwn(gpu, 'requestAdapter')).toBe(false);
});
