import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { readGpuRequests } from '@/features/llama-cpp-browser/runtime/webgpu-request-diagnostics';
import { LlamaCppBrowserError, usesWebGpu, type LlamaCppProfile } from '@/features/llama-cpp-browser/types';
import { prefillMicroBatchTokens } from './prefill-config';

const placementCapability = 'ggml_backend_webgpu_indexed_q2_placement_v1';
const weightShape = [640n, 2560n, 512n, 1n] as const;
const bytesPerExpert = 460800n;
const weightBytes = bytesPerExpert * weightShape[2];
const maximumWeightBytes = 9n * weightBytes;
const expertDownName = /^blk\.\d+\.ffn_down_exps\.weight$/u;

const requiredFunctions = [
  'ggml_backend_dev_by_type', 'ggml_backend_dev_backend_reg', 'ggml_backend_reg_get_proc_address',
  'ggml_backend_dev_buffer_type', 'ggml_backend_buft_get_device', 'ggml_backend_buft_get_alloc_size',
  'ggml_backend_buft_get_max_size', 'gguf_init_from_file', 'gguf_get_n_tensors', 'gguf_get_tensor_name',
  'gguf_get_tensor_type', 'gguf_get_tensor_ne', 'gguf_get_tensor_size', 'gguf_free', 'ggml_get_tensor',
  'ggml_free', 'llama_max_tensor_buft_overrides',
] as const;

function unavailable({ reason }: { reason: string }): never {
  throw new LlamaCppBrowserError({ code: 'unavailable', details: `Q2 placement: ${reason}` });
}

function invalidMetadata(): never {
  throw new LlamaCppBrowserError({ code: 'invalid-gguf', details: 'Q2 placement: invalid GGUF tensor metadata' });
}

function roundUp({ value, alignment }: { value: bigint, alignment: bigint }): bigint {
  return (value + alignment - 1n) & ~(alignment - 1n);
}

function checkDeviceLimits({ limits }: { limits: Readonly<Record<string, number>> | undefined }): bigint {
  const limit = ({ name }: { name: string }): bigint => {
    const value = limits?.[name];
    if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
      unavailable({ reason: `selected WebGPU device limit unavailable (${name})` });
    }
    return BigInt(value);
  };
  const requireLimit = ({ name, minimum }: { name: string, minimum: bigint }): void => {
    if (limit({ name }) < minimum) {
      unavailable({ reason: `selected WebGPU device limit ${name} is below ${minimum}` });
    }
  };
  const alignment = limit({ name: 'minStorageBufferOffsetAlignment' });
  if (alignment < 4n || (alignment & (alignment - 1n)) !== 0n) {
    unavailable({ reason: 'selected WebGPU device storage offset alignment is unsupported' });
  }
  const padded = roundUp({ value: weightBytes, alignment });
  const maxBuffer = limit({ name: 'maxBufferSize' });
  requireLimit({ name: 'maxBufferSize', minimum: padded });
  const maxBinding = limit({ name: 'maxStorageBufferBindingSize' });
  const split = maxBinding < weightBytes;
  if (split) {
    // Each range must contain whole experts and start at a valid storage offset.
    let fits = false;
    for (let first = bytesPerExpert; first < weightBytes; first += bytesPerExpert) {
      if (first % alignment === 0n && first <= maxBinding && weightBytes - first <= maxBinding) {
        fits = true;
        break;
      }
    }
    if (!fits) {
      unavailable({ reason: 'selected WebGPU device cannot fit two aligned Q2_0 expert weight ranges' });
    }
  }

  // The v1 resident path checks these limits for both matrix and vector use.
  requireLimit({ name: 'maxStorageBuffersPerShaderStage', minimum: split ? 6n : 5n });
  requireLimit({ name: 'maxBindingsPerBindGroup', minimum: split ? 7n : 6n });
  requireLimit({ name: 'maxUniformBuffersPerShaderStage', minimum: 1n });
  requireLimit({ name: 'maxUniformBufferBindingSize', minimum: 256n });
  requireLimit({ name: 'maxComputeWorkgroupStorageSize', minimum: 4352n });
  requireLimit({ name: 'maxComputeInvocationsPerWorkgroup', minimum: 256n });
  requireLimit({ name: 'maxComputeWorkgroupSizeX', minimum: 256n });
  const slots = 10n * BigInt(prefillMicroBatchTokens);
  const experts = slots < weightShape[2] ? slots : weightShape[2];
  const tiles = experts + (slots - experts) / 32n;
  const dimension = limit({ name: 'maxComputeWorkgroupsPerDimension' });
  const outputBytes = slots * weightShape[1] * 4n;
  const scratchBytes = 4n * (slots + 1n + 3n * tiles) + 2n * alignment;
  if (dimension * dimension < tiles * (weightShape[1] / 32n) ||
    maxBinding < outputBytes || maxBuffer < roundUp({ value: outputBytes + scratchBytes, alignment })) {
    unavailable({ reason: 'selected WebGPU device cannot fit the Q2_0 prefill grid or output and scratch' });
  }
  return maxBuffer;
}

export async function resolveQ2PlacementDevice({ core, profile }: { core: Core, profile: LlamaCppProfile }) {
  if (!usesWebGpu({ profile })) {
    unavailable({ reason: 'requires a WebGPU runtime' });
  }
  if (!requiredFunctions.every(name => core.hasFunction({ name }))) {
    unavailable({ reason: 'runtime lacks the required device or GGUF ABI' });
  }
  const { api } = core;
  // loadRuntime has initialized and selected this device through the same lookup.
  const device = await api.ggml_backend_dev_by_type(core.constant({ name: 'GGML_BACKEND_DEVICE_TYPE_GPU' }));
  const registry = device === 0n ? 0n : await api.ggml_backend_dev_backend_reg(device);
  if (registry === 0n) {
    unavailable({ reason: 'runtime has no selected WebGPU device' });
  }
  const name = core.utf8({ text: placementCapability });
  try {
    if (await api.ggml_backend_reg_get_proc_address(registry, name) === 0n) {
      unavailable({ reason: 'runtime does not advertise indexed Q2_0 placement v1' });
    }
  } finally {
    core.free({ pointer: name });
  }
  const metadata = readGpuRequests({ core })?.metadata;
  const maxBuffer = checkDeviceLimits({ limits: metadata?.deviceLimits });
  const buft = await api.ggml_backend_dev_buffer_type(device);
  if (buft === 0n || await api.ggml_backend_buft_get_device(buft) !== device) {
    unavailable({ reason: 'runtime has no buffer type for the selected WebGPU device' });
  }
  const maxAllocation = await api.ggml_backend_buft_get_max_size(buft);
  return { buft, maxAllocation: maxAllocation < maxBuffer ? maxAllocation : maxBuffer };
}

export async function inspectQ2Placement({ core, device, paths, allocations, signal }: {
  core: Core, device: Awaited<ReturnType<typeof resolveQ2PlacementDevice>>, paths: readonly string[],
  allocations: bigint[], signal: AbortSignal | undefined,
}): Promise<string[]> {
  const own = ({ pointer }: { pointer: bigint }): bigint => {
    allocations.push(pointer);
    return pointer;
  };
  const { api, pointerBytes } = core;
  const out = own({ pointer: core.alloc({ bytes: pointerBytes }) });
  const params = own({ pointer: core.allocRecord({ name: 'gguf_init_params' }) });
  core.setField({ name: 'gguf_init_params', pointer: params, field: 'no_alloc', value: 1 });
  core.setField({ name: 'gguf_init_params', pointer: params, field: 'ctx', value: out });
  const maximumNameBytes = Number(core.constant({ name: 'GGML_MAX_NAME' }));
  const q2Type = Number(core.constant({ name: 'GGML_TYPE_Q2_0' }));
  const decoder = new TextDecoder();
  const found: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    signal?.throwIfAborted();
    core.bytes({ pointer: out, length: pointerBytes }).fill(0);
    const file = own({ pointer: core.utf8({ text: path }) });
    let gguf = 0n;
    try {
      gguf = await api.gguf_init_from_file(file, params);
      const context = nativePointer({ core, pointer: out });
      if (gguf === 0n || context === 0n) {
        invalidMetadata();
      }
      const count = await api.gguf_get_n_tensors(gguf);
      if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) {
        invalidMetadata();
      }
      for (let index = 0n; index < count; index++) {
        signal?.throwIfAborted();
        const namePointer = await api.gguf_get_tensor_name(gguf, index);
        const heapEnd = BigInt(core.module.HEAPU8.byteLength);
        if (namePointer <= 0n || namePointer >= heapEnd) {
          invalidMetadata();
        }
        const bytes = core.bytes({ pointer: namePointer, length: Math.min(maximumNameBytes, Number(heapEnd - namePointer)) });
        const end = bytes.indexOf(0);
        if (end === -1) {
          invalidMetadata();
        }
        const name = decoder.decode(bytes.subarray(0, end));
        if (!expertDownName.test(name)) {
          continue;
        }
        if (seen.has(name)) {
          invalidMetadata();
        }
        seen.add(name);
        if (await api.gguf_get_tensor_type(gguf, index) !== q2Type) {
          continue;
        }
        const shapePointer = await api.gguf_get_tensor_ne(gguf, index);
        if (shapePointer === 0n) {
          invalidMetadata();
        }
        const span = core.bytes({ pointer: shapePointer, length: 32 });
        const dims = new DataView(span.buffer, span.byteOffset, span.byteLength);
        if (!weightShape.every((size, dimension) => size === dims.getBigInt64(8 * dimension, true))) {
          continue;
        }
        if (await api.gguf_get_tensor_size(gguf, index) !== weightBytes) {
          invalidMetadata();
        }
        if (BigInt(found.length + 1) * weightBytes > maximumWeightBytes) {
          unavailable({ reason: `eligible Q2_0 packed weights exceed ${maximumWeightBytes} bytes for this comparison` });
        }
        const tensor = await api.ggml_get_tensor(context, namePointer);
        if (tensor === 0n) {
          invalidMetadata();
        }
        const allocation = await api.ggml_backend_buft_get_alloc_size(device.buft, tensor);
        if (allocation < weightBytes || allocation > device.maxAllocation) {
          unavailable({ reason: 'selected WebGPU buffer type cannot allocate an eligible Q2_0 tensor' });
        }
        found.push(name);
      }
    } finally {
      const context = nativePointer({ core, pointer: out });
      try {
        if (context !== 0n) {
          await api.ggml_free(context);
        }
      } finally {
        if (gguf !== 0n) {
          await api.gguf_free(gguf);
        }
      }
    }
  }
  signal?.throwIfAborted();
  if (!found.length) {
    unavailable({ reason: 'model has no eligible Q2_0 expert-down weights (640 × 2560 × 512)' });
  }
  if (BigInt(found.length + 1) > await api.llama_max_tensor_buft_overrides()) {
    unavailable({ reason: 'model exceeds the native tensor override limit' });
  }
  return found;
}

function nativePointer({ core, pointer }: { core: Core, pointer: bigint }): bigint {
  const bytes = core.bytes({ pointer, length: core.pointerBytes });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return core.pointerBytes === 8 ? view.getBigUint64(0, true) : BigInt(view.getUint32(0, true));
}

export function setQ2PlacementOverrides({ core, params, names, buft, allocations }: {
  core: Core, params: bigint, names: readonly string[], buft: bigint, allocations: bigint[],
}): void {
  const name = 'llama_model_tensor_buft_override';
  const stride = core.recordSize({ name });
  const length = stride * (names.length + 1);
  const overrides = core.alloc({ bytes: length });
  allocations.push(overrides);
  core.bytes({ pointer: overrides, length }).fill(0);
  for (const [index, tensorName] of names.entries()) {
    const pattern = core.utf8({ text: `^${tensorName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$` });
    allocations.push(pattern);
    const pointer = overrides + BigInt(stride * index);
    core.setField({ name, pointer, field: 'pattern', value: pattern });
    core.setField({ name, pointer, field: 'buft', value: buft });
  }
  core.setField({ name: 'llama_model_params', pointer: params, field: 'tensor_buft_overrides', value: overrides });
}

export const TEST_ONLY = {
  checkDeviceLimits,
};
