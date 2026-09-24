import { describe, expect, it, vi } from 'vitest';
import { createCoreWebGpuNavigator, TEST_ONLY, type DispatchSplit } from './webgpu-dispatch';

const source = `\
@group(0) @binding(0) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
    output[wid.x * 64u + lid.x] = wid.x;
}
`;
type Draw = { count: number[], constants: Record<string, number>, pipeline: GPUComputePipeline, offsets: number[], group: GPUBindGroup | null };
function fixture({ limit }: { limit: number }) {
  const draws: Draw[] = [];
  const pipelineDescriptors = new Map<GPUComputePipeline, GPUComputePipelineDescriptor>();
  const groupDescriptors = new Map<GPUBindGroup, GPUBindGroupDescriptor>();
  const shaderDescriptors: GPUShaderModuleDescriptor[] = [];
  let current: GPUComputePipeline | undefined;
  let group: GPUBindGroup | null = null;
  let offsets: number[] = [];
  const pass = {
    setPipeline(pipeline: GPUComputePipeline) {
      current = pipeline;
    },
    setBindGroup(_index: number, value: GPUBindGroup | null, data?: number[] | Uint32Array, start?: number, length?: number) {
      group = value;
      offsets = data instanceof Uint32Array && start !== undefined ? Array.from(data.subarray(start, start + length!)) : Array.from(data ?? []);
    },
    dispatchWorkgroups(x: number, y?: number, z?: number) {
      const count = [x, y ?? 1, z ?? 1];
      if (count.some(value => value > limit)) throw new Error('Native dispatch overflow');
      if (!current) throw new Error('Missing pipeline');
      if (group && Reflect.get(groupDescriptors.get(group)!.layout, 'owner') !== current) throw new Error('Exclusive auto layout mismatch');
      draws.push({ count, constants: { ...pipelineDescriptors.get(current)!.compute.constants }, pipeline: current, offsets: [...offsets], group });
    },
    dispatchWorkgroupsIndirect() {
      if (!current) throw new Error('Missing pipeline');
    },
    end: vi.fn(),
  };
  const encoder = { beginComputePass() {
    return pass as unknown as GPUComputePassEncoder;
  }, finish: vi.fn(() => ({ marker: 'command-buffer' })) };
  const raw = {
    limits: { maxComputeWorkgroupsPerDimension: limit },
    queue: { submit: vi.fn() },
    createShaderModule(descriptor: GPUShaderModuleDescriptor) {
      shaderDescriptors.push({ ...descriptor }); return { marker: shaderDescriptors.length } as unknown as GPUShaderModule;
    },
    createComputePipeline(descriptor: GPUComputePipelineDescriptor) {
      const layouts = new Map<number, GPUBindGroupLayout>();
      const pipeline: GPUComputePipeline = { label: descriptor.label ?? '', getBindGroupLayout(index: number) {
        let layout = layouts.get(index);
        if (!layout) {
          layout = { owner: pipeline, index } as unknown as GPUBindGroupLayout; layouts.set(index, layout);
        }
        return layout;
      } } as GPUComputePipeline;
      pipelineDescriptors.set(pipeline, descriptor); return pipeline;
    },
    async createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor) {
      return this.createComputePipeline(descriptor);
    },
    createBindGroup(descriptor: GPUBindGroupDescriptor) {
      const group = {} as GPUBindGroup; groupDescriptors.set(group, descriptor); return group;
    },
    createCommandEncoder() {
      return encoder as unknown as GPUCommandEncoder;
    },
    destroy: vi.fn(),
  };
  const reports: DispatchSplit[] = [];
  const device = TEST_ONLY.wrapDevice({ device: raw as unknown as GPUDevice, report(detail) {
    reports.push(detail);
  } });
  function prepare({ code }: { code: string }) {
    const shader = device.createShaderModule({ code });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: shader, entryPoint: 'main', constants: { original: 7 } } });
    const buffer = { marker: 'tensor' } as unknown as GPUBuffer;
    const descriptor: GPUBindGroupDescriptor = { layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer, offset: 256, size: 8192 } }] };
    const group = device.createBindGroup(descriptor);
    const pass = device.createCommandEncoder().beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group);
    return { pipeline, group, buffer, pass, descriptor };
  }
  return { raw, device, prepare, draws, pipelineDescriptors, groupDescriptors, shaderDescriptors, reports };
}

describe('logical dispatch partition', () => {
  it.each([1, 65535, 65536, 65537, 116100, 131070, 131071])('covers %i workgroups exactly once, without padding', count => {
    const chunks = TEST_ONLY.planDispatch({ grid: [count, 1, 1], limit: 65535 });
    let next = 0;
    for (const chunk of chunks) {
      expect(chunk.offset).toEqual([next, 0, 0]);
      expect(chunk.count[0]).toBeLessThanOrEqual(65535);
      expect(chunk.count[1]).toBe(1); expect(chunk.count[2]).toBe(1);
      next += chunk.count[0];
    }
    expect(next).toBe(count);
  });
  it('covers all three axes exactly once with a small test-device limit', () => {
    const chunks = TEST_ONLY.planDispatch({ grid: [9, 7, 5], limit: 4 });
    const seen = new Set<string>();
    for (const { offset, count } of chunks) {
      expect(count.every(value => value <= 4)).toBe(true);
      for (let z = 0; z < count[2]; z++) for (let y = 0; y < count[1]; y++) for (let x = 0; x < count[0]; x++) {
        const key = `${x + offset[0]},${y + offset[1]},${z + offset[2]}`;
        expect(seen.has(key)).toBe(false); seen.add(key);
      }
    }
    expect(seen.size).toBe(9 * 7 * 5);
  });
  it('handles zero work without manufacturing a nonempty dispatch', () => {
    expect(TEST_ONLY.planDispatch({ grid: [116100, 0, 1], limit: 65535 })).toEqual([]);
  });
  it.each([NaN, Infinity, -1, 1.5, 0x100000000])('rejects invalid count %s', count => {
    expect(() => TEST_ONLY.planDispatch({ grid: [count, 1, 1], limit: 65535 })).toThrow('count');
  });
  it('bounds the number of host-side specializations instead of truncating work', () => {
    expect(() => TEST_ONLY.planDispatch({ grid: [65535 * (TEST_ONLY.maxChunks + 1), 1, 1], limit: 65535 })).toThrow('too many chunks');
  });
});

describe('scoped WebGPU compatibility facade', () => {
  it('passes ordinary dispatches through with the original shader, pipeline, resources, and default dimensions', () => {
    const f = fixture({ limit: 65535 }); const p = f.prepare({ code: source });
    p.pass.dispatchWorkgroups(65535); p.pass.dispatchWorkgroups(0, 1, 1);
    expect(f.draws.map(draw => draw.count)).toEqual([[65535, 1, 1], [0, 1, 1]]);
    expect(f.draws[0]!.pipeline).toBe(p.pipeline); expect(f.draws[0]!.group).toBe(p.group);
    expect(f.shaderDescriptors).toEqual([{ code: source }]); expect(f.pipelineDescriptors.size).toBe(1);
    expect(f.reports).toEqual([]);
  });
  it('splits the reported 116100 count into 65535 + 50565 and fixes the second origin on GPU', () => {
    const f = fixture({ limit: 65535 }); const p = f.prepare({ code: source });
    p.pass.dispatchWorkgroups(116100, 1, 1);
    expect(f.draws.map(draw => draw.count)).toEqual([[65535, 1, 1], [50565, 1, 1]]);
    expect(f.draws[0]!.pipeline).toBe(p.pipeline);
    expect(f.draws[1]!.constants).toMatchObject({ original: 7, naidan_dispatch_offset_x: 65535, naidan_dispatch_offset_y: 0, naidan_dispatch_offset_z: 0 });
    expect(f.draws[1]!.group).not.toBe(p.group);
    expect(f.groupDescriptors.get(f.draws[1]!.group!)!.entries[0]!.resource).toEqual({ buffer: p.buffer, offset: 256, size: 8192 });
    expect(f.reports).toEqual([{ axis: 'x', count: 116100, limit: 65535, chunks: 2 }]);
    // No redundant native setPipeline/setBindGroup before the next dispatch.
    p.pass.dispatchWorkgroups(20);
    expect(f.draws[2]!.pipeline).toBe(p.pipeline); expect(f.draws[2]!.group).toBe(p.group);
  });
  it('keeps image tensor data on the original GPU buffer and caches variants across shapes', () => {
    const f = fixture({ limit: 65535 }); const p = f.prepare({ code: source });
    p.pass.dispatchWorkgroups(116100); const variants = f.pipelineDescriptors.size;
    p.pass.dispatchWorkgroups(70000);
    expect(f.pipelineDescriptors.size).toBe(variants); expect(f.shaderDescriptors).toHaveLength(2);
    expect(f.draws[3]!.pipeline).toBe(f.draws[1]!.pipeline);
    expect(f.draws[3]!.group).toBe(f.draws[1]!.group); expect(f.reports).toHaveLength(1);
  });
  it('snapshots dynamic offsets before the native heap view is reused', () => {
    const f = fixture({ limit: 65535 }); const p = f.prepare({ code: source });
    const offsets = new Uint32Array([0, 256, 512, 768]);
    p.pass.setBindGroup(0, p.group, offsets, 1, 2); offsets.fill(0);
    p.pass.dispatchWorkgroups(116100);
    expect(f.draws.map(draw => draw.offsets)).toEqual([[256, 512], [256, 512]]);
  });
  it('preserves the three-argument iterable form of setBindGroup and copies descriptor values', () => {
    const f = fixture({ limit: 65535 }); const p = f.prepare({ code: source });
    const offsets = [256]; p.pass.setBindGroup(0, p.group, offsets); offsets[0] = 0;
    p.descriptor.entries.length = 0;
    p.pass.dispatchWorkgroups(116100);
    expect(f.draws[1]!.offsets).toEqual([256]);
    expect(f.groupDescriptors.get(f.draws[1]!.group!)!.entries).toHaveLength(1);
  });
  it('preserves num_workgroups instead of exposing the smaller physical chunk grid', () => {
    const f = fixture({ limit: 4 });
    const p = f.prepare({ code: source.replace('@builtin(local_invocation_id)', '@builtin(num_workgroups)') });
    p.pass.dispatchWorkgroups(7, 3, 1);
    expect(f.draws).toHaveLength(2);
    for (const draw of f.draws) expect(draw.constants).toMatchObject({ naidan_dispatch_grid_x: 7, naidan_dispatch_grid_y: 3, naidan_dispatch_grid_z: 1 });
    expect(f.draws[0]!.pipeline).not.toBe(p.pipeline);
    p.pass.dispatchWorkgroups(2, 1, 1); expect(f.draws[2]!.pipeline).toBe(p.pipeline);
  });
  it('uses device limits rather than a hardcoded 65535 or an inflated requested limit', () => {
    const f = fixture({ limit: 131072 }); const p = f.prepare({ code: source });
    p.pass.dispatchWorkgroups(116100);
    expect(f.draws).toHaveLength(1); expect(f.pipelineDescriptors.size).toBe(1);
  });
  it('rejects unknown oversized shader syntax before encoding any of the operation', () => {
    const f = fixture({ limit: 65535 }); const p = f.prepare({ code: source.replace('workgroup_size(64)', 'workgroup_size(32 * 2)') });
    p.pass.dispatchWorkgroups(10);
    expect(() => p.pass.dispatchWorkgroups(116100)).toThrow('Unsupported WebGPU shader');
    expect(f.draws).toHaveLength(1);
    p.pass.dispatchWorkgroups(11); expect(f.draws[1]!.pipeline).toBe(p.pipeline);
  });
  it('rejects untracked pipelines before issuing an overflowing native request', () => {
    const f = fixture({ limit: 65535 }); const p = f.prepare({ code: source });
    p.pass.setPipeline({} as GPUComputePipeline);
    expect(() => p.pass.dispatchWorkgroups(116100)).toThrow('Untracked WebGPU pipeline');
    expect(f.draws).toHaveLength(0);
  });
  it('rejects untracked bind groups before issuing the first chunk', () => {
    const f = fixture({ limit: 4 }); const p = f.prepare({ code: source });
    const group = f.raw.createBindGroup({ layout: p.pipeline.getBindGroupLayout(0), entries: [] });
    p.pass.setBindGroup(0, group);
    expect(() => p.pass.dispatchWorkgroups(7)).toThrow('Untracked WebGPU bind group');
    expect(f.draws).toHaveLength(0);
  });
  it('forwards genuine device creation errors instead of silently selecting a CPU backend', async () => {
    const failure = new Error('device creation failure');
    const adapter = { requestDevice: vi.fn(async () => {
      throw failure;
    }) } as unknown as GPUAdapter;
    const gpu = { requestAdapter: vi.fn(async () => adapter) } as unknown as GPU;
    const wrapped = createCoreWebGpuNavigator({ navigator: { gpu }, report() {} })!;
    const selected = await wrapped.gpu.requestAdapter();
    await expect(selected!.requestDevice()).rejects.toBe(failure);
  });
  it('does not let a diagnostic callback failure change GPU work', () => {
    const f = fixture({ limit: 4 });
    const device = TEST_ONLY.wrapDevice({ device: f.raw as unknown as GPUDevice, report() {
      throw new Error('logging');
    } });
    const module = device.createShaderModule({ code: source });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module } });
    const pass = device.createCommandEncoder().beginComputePass(); pass.setPipeline(pipeline);
    expect(() => pass.dispatchWorkgroups(7)).not.toThrow(); expect(f.draws).toHaveLength(2);
  });
  it('tracks asynchronous pipeline creation too', async () => {
    const f = fixture({ limit: 4 });
    const module = f.device.createShaderModule({ code: source });
    const pipeline = await f.device.createComputePipelineAsync({ layout: 'auto', compute: { module } });
    const pass = f.device.createCommandEncoder().beginComputePass(); pass.setPipeline(pipeline); pass.dispatchWorkgroups(7);
    expect(f.draws).toHaveLength(2);
  });
  it('retains native this receivers, event setters, and unwrapped return values', () => {
    const target = { value: 3, method() {
      expect(this).toBe(target); return this.value;
    } };
    const wrapped = TEST_ONLY.facade({ target, overrides: {} });
    expect(wrapped.method()).toBe(3); expect(wrapped.method).toBe(wrapped.method);
    wrapped.value = 5; expect(target.value).toBe(5);
    const f = fixture({ limit: 65535 }); expect(f.device.queue).toBe(f.raw.queue);
    f.device.destroy(); expect(f.raw.destroy).toHaveBeenCalledOnce();
  });
  it('isolates different devices and their resources', () => {
    const a = fixture({ limit: 4 }); const b = fixture({ limit: 8 });
    const p = a.prepare({ code: source }); const q = b.prepare({ code: source });
    p.pass.dispatchWorkgroups(7); q.pass.dispatchWorkgroups(7);
    expect(a.draws).toHaveLength(2); expect(b.draws).toHaveLength(1);
    expect(b.shaderDescriptors).toHaveLength(1);
  });
  it('bounds the pipeline cache while retaining every chunk and the original numeric constants', () => {
    const f = fixture({ limit: 4 }); const p = f.prepare({ code: source });
    p.pass.dispatchWorkgroups(4 * (TEST_ONLY.maxVariants + 2));
    expect(f.draws).toHaveLength(TEST_ONLY.maxVariants + 2);
    for (let i = 0; i < f.draws.length; i++) {
      expect(f.draws[i]!.constants.original).toBe(7);
      expect(f.draws[i]!.constants.naidan_dispatch_offset_x ?? 0).toBe(i * 4);
    }
    p.pass.dispatchWorkgroups(2);
    expect(f.draws.at(-1)!.pipeline).toBe(p.pipeline);
    p.pass.dispatchWorkgroups(7);
    expect(f.draws.at(-1)!.constants.naidan_dispatch_offset_x).toBe(4);
    expect(f.draws.at(-1)!.pipeline).not.toBe(f.draws[1]!.pipeline); // oldest variant was evicted
  });
  it('keeps the logical grid on every chunk even when that is the only nonlocal builtin', () => {
    const f = fixture({ limit: 4 });
    const p = f.prepare({ code: source.replace('workgroup_id', 'num_workgroups') });
    p.pass.dispatchWorkgroups(7);
    expect(f.draws).toHaveLength(2);
    for (const draw of f.draws) {
      expect(draw.constants.naidan_dispatch_grid_x).toBe(7);
      expect(draw.constants).not.toHaveProperty('naidan_dispatch_offset_x');
    }
  });
  it('does not alias offsets and descriptors mutated during asynchronous pipeline creation', async () => {
    const f = fixture({ limit: 4 });
    const shader = f.device.createShaderModule({ code: source });
    const descriptor: GPUComputePipelineDescriptor = { layout: 'auto', compute: { module: shader, constants: { original: 1 } } };
    const pending = f.device.createComputePipelineAsync(descriptor);
    descriptor.compute.constants!.original = 999;
    const pipeline = await pending;
    const pass = f.device.createCommandEncoder().beginComputePass(); pass.setPipeline(pipeline);
    pass.dispatchWorkgroups(7);
    expect(f.draws[1]!.constants.original).toBe(1);
  });
  it('restores the real pipeline before indirect and ordinary dispatches', () => {
    const f = fixture({ limit: 4 }); const p = f.prepare({ code: source });
    p.pass.dispatchWorkgroups(7);
    p.pass.dispatchWorkgroupsIndirect({} as GPUBuffer, 0);
    p.pass.dispatchWorkgroups(2);
    expect(f.draws.at(-1)!.pipeline).toBe(p.pipeline);
    expect(p.pass.end()).toBeUndefined();
  });
  it('is lazy, leaves globals alone, and forwards adapter/device options and limits unchanged', async () => {
    const f = fixture({ limit: 65535 });
    const requestDevice = vi.fn(async (_descriptor: GPUDeviceDescriptor | undefined) => f.raw as unknown as GPUDevice);
    const adapter = { requestDevice } as unknown as GPUAdapter;
    const requestAdapter = vi.fn(async (_options: GPURequestAdapterOptions | undefined) => adapter);
    const gpu = { requestAdapter, wgslLanguageFeatures: new Set(['feature']) } as unknown as GPU;
    const navigator = { gpu };
    const wrapped = createCoreWebGpuNavigator({ navigator, report() {} })!;
    expect(requestAdapter).not.toHaveBeenCalled(); expect(navigator.gpu).toBe(gpu);
    expect(wrapped.gpu.wgslLanguageFeatures).toBe(gpu.wgslLanguageFeatures);
    const options = { powerPreference: 'high-performance' } as const;
    const descriptor = { requiredLimits: { maxComputeWorkgroupsPerDimension: 65535 } };
    const wrappedAdapter = await wrapped.gpu.requestAdapter(options);
    const device = await wrappedAdapter!.requestDevice(descriptor);
    expect(requestAdapter).toHaveBeenCalledWith(options); expect(requestDevice).toHaveBeenCalledWith(descriptor);
    expect(device.limits).toBe(f.raw.limits);
  });
  it('preserves missing WebGPU and unavailable adapters, rather than changing profiles', async () => {
    expect(createCoreWebGpuNavigator({ navigator: undefined, report() {} })).toBeUndefined();
    const gpu = { requestAdapter: async () => null } as unknown as GPU;
    const wrapped = createCoreWebGpuNavigator({ navigator: { gpu }, report() {} })!;
    expect(await wrapped.gpu.requestAdapter()).toBeNull();
  });
});
