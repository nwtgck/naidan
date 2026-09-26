import { adaptDispatchShader, type DispatchShader } from './webgpu-dispatch-shader';

const axes = ['x', 'y', 'z'] as const;
type Grid = readonly [number, number, number];
type Chunk = { offset: Grid, count: Grid };
// Bound host-side specialization work, not image resolution. A normal affected
// image needs two chunks. Never silently drop work when this bound is exceeded.
const maxChunks = 256;
const maxVariants = 16;
export type DispatchSplit = { axis: 'x' | 'y' | 'z', count: number, limit: number, chunks: number };

function planDispatch({ grid, limit }: { grid: Grid, limit: number }): Chunk[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid WebGPU dispatch limit');
  if (grid.some(value => !Number.isInteger(value) || value < 0 || value > 0xffffffff)) throw new RangeError('Invalid WebGPU dispatch count');
  if (grid.some(value => value === 0)) return [];
  if (grid.reduce((product, value) => product * Math.ceil(value / limit), 1) > maxChunks) throw new RangeError('WebGPU dispatch requires too many chunks');
  const chunks: Chunk[] = [];
  for (let z = 0; z < grid[2]; z += limit) {
    for (let y = 0; y < grid[1]; y += limit) {
      for (let x = 0; x < grid[0]; x += limit) {
        chunks.push({ offset: [x, y, z], count: [Math.min(limit, grid[0] - x), Math.min(limit, grid[1] - y), Math.min(limit, grid[2] - z)] });
      }
    }
  }
  return chunks;
}

/** Keep native receivers for WebIDL brand checks, accessors, event properties
 * and unwrapped methods. Only this facade is changed, never browser prototypes. */
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

type Variant = { pipeline: GPUComputePipeline, groups: WeakMap<GPUBindGroup, Map<number, GPUBindGroup>> };
type Pipeline = {
  descriptor: GPUComputePipelineDescriptor,
  shader: (Omit<DispatchShader, 'code'> & { module: GPUShaderModule }) | undefined,
  variants: Map<string, Variant>,
  reported: boolean,
};
type Binding = { group: GPUBindGroup | null, offsets: number[] };

function wrapDevice({ device, report }: { device: GPUDevice, report: ({ axis, count, limit, chunks }: DispatchSplit) => void }): GPUDevice {
  const shaders = new WeakMap<GPUShaderModule, GPUShaderModuleDescriptor>();
  const pipelines = new WeakMap<GPUComputePipeline, Pipeline>();
  const groups = new WeakMap<GPUBindGroup, GPUBindGroupDescriptor>();
  const limit = device.limits.maxComputeWorkgroupsPerDimension;
  function rememberPipeline({ pipeline, descriptor }: { pipeline: GPUComputePipeline, descriptor: GPUComputePipelineDescriptor }): GPUComputePipeline {
    pipelines.set(pipeline, { descriptor: { ...descriptor, compute: { ...descriptor.compute, constants: { ...descriptor.compute.constants } } }, shader: undefined, variants: new Map(), reported: false });
    return pipeline;
  }
  function variant({ state, original, offset, grid }: { state: Pipeline, original: GPUComputePipeline, offset: Grid, grid: Grid }): Variant {
    if (!state.shader) {
      const descriptor = shaders.get(state.descriptor.compute.module);
      const shader = descriptor && adaptDispatchShader({ source: descriptor.code, entryPoint: state.descriptor.compute.entryPoint });
      if (!descriptor || !shader) throw new Error('Unsupported WebGPU shader for oversized dispatch; this dispatch was not encoded');
      // No tensor buffers, bind-group entries, or numerical expressions change.
      const { code, ...interfaceInfo } = shader;
      state.shader = { module: device.createShaderModule({ ...descriptor, code }), ...interfaceInfo };
    }
    if (!state.shader.gridDependent && offset.every(value => value === 0)) return { pipeline: original, groups: new WeakMap() };
    const key = `${state.shader.offsetDependent ? offset.join(',') : ''}/${state.shader.gridDependent ? grid.join(',') : ''}`;
    let cached = state.variants.get(key);
    if (cached) {
      state.variants.delete(key); state.variants.set(key, cached);
      return cached;
    }
    const constants = { ...state.descriptor.compute.constants };
    for (const [index, axis] of axes.entries()) {
      if (state.shader.offsetDependent) constants[`naidan_dispatch_offset_${axis}`] = offset[index]!;
      if (state.shader.gridDependent) constants[`naidan_dispatch_grid_${axis}`] = grid[index]!;
    }
    cached = {
      pipeline: device.createComputePipeline({ ...state.descriptor, compute: { ...state.descriptor.compute, module: state.shader.module, constants } }),
      groups: new WeakMap(),
    };
    state.variants.set(key, cached);
    if (state.variants.size > maxVariants) state.variants.delete(state.variants.keys().next().value!);
    return cached;
  }
  function compatibleGroup({ variant, index, original }: { variant: Variant, index: number, original: GPUBindGroup }): GPUBindGroup {
    const descriptor = groups.get(original);
    if (!descriptor) throw new Error('Untracked WebGPU bind group for oversized dispatch');
    let byIndex = variant.groups.get(original);
    if (!byIndex) {
      byIndex = new Map(); variant.groups.set(original, byIndex);
    }
    let group = byIndex.get(index);
    if (!group) {
      // Auto layouts are pipeline-exclusive. Reusing the original bind group
      // for a specialized pipeline would itself be a WebGPU validation error.
      group = device.createBindGroup({ ...descriptor, layout: variant.pipeline.getBindGroupLayout(index) });
      byIndex.set(index, group);
    }
    return group;
  }
  function wrapPass({ pass }: { pass: GPUComputePassEncoder }): GPUComputePassEncoder {
    let current: GPUComputePipeline | undefined;
    const bindings = new Map<number, Binding>();
    return facade({ target: pass, overrides: {
      setPipeline(pipeline) {
        pass.setPipeline(pipeline); current = pipeline;
      },

      setBindGroup(index: number, group: GPUBindGroup | null, data?: number[] | Uint32Array, start?: number, length?: number) {
        if (data instanceof Uint32Array && (start !== undefined || length !== undefined)) {
          pass.setBindGroup(index, group, data, start!, length!);
          // Emscripten reuses its heap view. Snapshot the selected range now.
          bindings.set(index, { group, offsets: Array.from(data.subarray(start, start! + length!)) });
        } else {
          const offsets = data ? Array.from(data) : [];
          pass.setBindGroup(index, group, offsets);
          bindings.set(index, { group, offsets });
        }
      },

      dispatchWorkgroups(x: number, y?: number, z?: number) {
        const grid: Grid = [x, y ?? 1, z ?? 1];
        if (grid.every(value => value <= limit)) {
          pass.dispatchWorkgroups(x, y, z); return;
        }
        const chunks = planDispatch({ grid, limit });
        if (chunks.length === 0) {
          pass.dispatchWorkgroups(0, 0, 0); return;
        }
        const state = current && pipelines.get(current);
        if (!state || !current) throw new Error('Untracked WebGPU pipeline for oversized dispatch');
        const original = current;
        // Resolve every descriptor before encoding: an unsupported shader or
        // resource must not leave a partly encoded split operation.
        const prepared = chunks.map(chunk => {
          const selected = variant({ state, original, offset: chunk.offset, grid });
          const selectedBindings = [...bindings].map(([index, binding]) => ({ index, ...binding,
            group: binding.group && selected.pipeline !== original && state.shader!.bindingGroups.includes(index) ? compatibleGroup({ variant: selected, index, original: binding.group }) : binding.group,
          }));
          return { ...chunk, pipeline: selected.pipeline, bindings: selectedBindings };
        });
        try {
          for (const chunk of prepared) {
            pass.setPipeline(chunk.pipeline);
            for (const binding of chunk.bindings) pass.setBindGroup(binding.index, binding.group, binding.offsets);
            pass.dispatchWorkgroups(...chunk.count);
          }
        } finally {
          // Native code can reuse a pipeline, use indirect dispatch, or omit a
          // redundant setBindGroup next time. Never leak the specialized state.
          pass.setPipeline(original);
          for (const [index, binding] of bindings) pass.setBindGroup(index, binding.group, binding.offsets);
        }
        if (!state.reported) {
          state.reported = true;
          for (const [index, axis] of axes.entries()) if (grid[index]! > limit) {
            try {
              report({ axis, count: grid[index]!, limit, chunks: chunks.length });
            } catch { /* Diagnostics are not inference. */ }
          }
        }
      },
    } });
  }
  return facade({ target: device, overrides: {
    createShaderModule(descriptor) {
      const module = device.createShaderModule(descriptor);
      shaders.set(module, { ...descriptor }); return module;
    },
    createComputePipeline(descriptor) {
      return rememberPipeline({ pipeline: device.createComputePipeline(descriptor), descriptor });
    },
    async createComputePipelineAsync(descriptor) {
      // Snapshot before awaiting: WebIDL consumes the descriptor at call time.
      const snapshot = { ...descriptor, compute: { ...descriptor.compute, constants: { ...descriptor.compute.constants } } };
      return rememberPipeline({ pipeline: await device.createComputePipelineAsync(descriptor), descriptor: snapshot });
    },
    createBindGroup(descriptor) {
      const group = device.createBindGroup(descriptor);
      groups.set(group, { ...descriptor, entries: descriptor.entries.map(entry => ({ ...entry,
        resource: 'buffer' in entry.resource ? { ...entry.resource } : entry.resource,
      })) });
      return group;
    },
    createCommandEncoder(descriptor) {
      const encoder = device.createCommandEncoder(descriptor);
      return facade({ target: encoder, overrides: { beginComputePass(passDescriptor) {
        return wrapPass({ pass: encoder.beginComputePass(passDescriptor) });
      } } });
    },
  } });
}

/** Passed only into this core factory's lexical navigator binding. No global
 * navigator/GPU prototypes, lcore files, Wasm bytes, or reported limits change. */
export function createCoreWebGpuNavigator({ navigator, report }: {
  navigator: Pick<Navigator, 'gpu'> | undefined, report: ({ axis, count, limit, chunks }: DispatchSplit) => void,
}): Pick<Navigator, 'gpu'> | undefined {
  if (!navigator?.gpu) return navigator;
  const gpu = navigator.gpu;
  // Snapshot the entry point before a caller installs this scoped facade into
  // its dedicated Worker. Looking it up again would recurse into that hook.
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  return facade({ target: navigator, overrides: { gpu: facade({ target: gpu, overrides: {
    async requestAdapter(options) {
      const adapter = await requestAdapter(options);
      if (!adapter) return adapter;
      return facade({ target: adapter, overrides: { async requestDevice(descriptor) {
        return wrapDevice({ device: await adapter.requestDevice(descriptor), report });
      } } });
    },
  } }) } });
}
export const TEST_ONLY = {
  planDispatch,
  facade,
  wrapDevice,
  maxChunks,
  maxVariants,
};
