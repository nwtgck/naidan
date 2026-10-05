import { imageEngineSnapshotSchema, type ImageEngineInspection } from '@/features/stable-diffusion-cpp-browser/engine-state';
import { imageErrorContext } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import type { Core } from './core-types';

/** The session owns an idle context throughout this call. No background sampling,
 * GPU synchronization or reads of tensor payloads are introduced. */
export async function inspectImageEngine({ core, context, profile, source, modelVersion, fileReadCacheBytes }: {
  core: Pick<Core, 'busy' | 'allocRecord' | 'recordSize' | 'getField' | 'constant' | 'free' | 'readUtf8'> & {
    api: Pick<Core['api'], 'sd_ctx_get_runtime_info' | 'sd_ctx_get_memory_info' | 'sd_ctx_get_params'>,
    module: Pick<Core['module'], 'HEAPU8'>,
  },
  context: bigint, profile: string, source: string, modelVersion: string, fileReadCacheBytes: number,
}): Promise<ImageEngineInspection> {
  if (core.busy) return { status: 'unavailable', reason: 'busy' };
  const runtimeGetter = core.api.sd_ctx_get_runtime_info;
  const memoryGetter = core.api.sd_ctx_get_memory_info;
  const paramsGetter = core.api.sd_ctx_get_params;
  if (!runtimeGetter || !memoryGetter || !paramsGetter) return { status: 'unavailable', reason: 'unsupported' };
  const allocations: bigint[] = [];
  let poisoned = false;
  let result: ImageEngineInspection;
  try {
    const allocate = ({ record }: { record: string }) => {
      const pointer = core.allocRecord(record); allocations.push(pointer); return pointer;
    };
    const runtimeRecord = 'sd_runtime_info_t', memoryRecord = 'sd_memory_info_t', paramsRecord = 'sd_ctx_params_t';
    const runtime = allocate({ record: runtimeRecord }), memory = allocate({ record: memoryRecord }), params = allocate({ record: paramsRecord });
    if (await runtimeGetter(context, runtime, BigInt(core.recordSize(runtimeRecord))) !== 1
      || await memoryGetter(context, memory, BigInt(core.recordSize(memoryRecord))) !== 1
      || await paramsGetter(context, params, BigInt(core.recordSize(paramsRecord))) !== 1) {
      throw new Error('The idle image context did not return a state snapshot');
    }
    for (const { record, pointer } of [{ record: runtimeRecord, pointer: runtime }, { record: memoryRecord, pointer: memory }]) {
      if (Number(core.getField(record, pointer, 'version')) !== 1
        || Number(core.getField(record, pointer, 'struct_size')) !== core.recordSize(record)) throw new Error('Unsupported image engine snapshot layout');
    }
    const runtimeFlag = ({ field }: { field: string }) => Number(core.getField(runtimeRecord, runtime, field)) === 1;
    const parameter = ({ field }: { field: string }) => core.getField(paramsRecord, params, field);
    const parameterText = ({ field }: { field: string }) => {
      const pointer = BigInt(parameter({ field }));
      // These strings are borrowed; copy now and never expose or free pointers.
      return pointer === 0n ? '' : core.readUtf8(pointer, 513) ?? '';
    };
    const memoryValue = ({ field }: { field: string }) => {
      const value = core.getField(memoryRecord, memory, field);
      if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Inexact image engine memory value');
      return BigInt(value).toString();
    };
    const bf16Type = Number(parameter({ field: 'webgpu_bf16_type' }));
    result = { status: 'ready', snapshot: imageEngineSnapshotSchema.parse({
      type: 'naidan-image-engine-snapshot-v1', collectedAt: Date.now(), profile, source, modelVersion,
      wasmCapacityBytes: core.module.HEAPU8.byteLength, fileReadCacheBytes,
      runtime: {
        nThreads: Number(core.getField(runtimeRecord, runtime, 'n_threads')),
        runnersReady: runtimeFlag({ field: 'runners_ready' }), eagerLoad: runtimeFlag({ field: 'eager_load' }),
        mmap: runtimeFlag({ field: 'enable_mmap' }), prefetch: !runtimeFlag({ field: 'disable_prefetch' }),
        segmentedCompute: !runtimeFlag({ field: 'disable_segmented_compute' }), autoFit: runtimeFlag({ field: 'auto_fit_enabled' }),
      },
      memory: {
        registeredTensorCount: memoryValue({ field: 'registered_tensor_count' }), registeredTensorBytes: memoryValue({ field: 'registered_tensor_bytes' }),
        managerHostBufferCount: memoryValue({ field: 'manager_host_buffer_count' }), managerHostBufferBytes: memoryValue({ field: 'manager_host_buffer_bytes' }),
        managerDeviceBufferCount: memoryValue({ field: 'manager_device_buffer_count' }), managerDeviceBufferBytes: memoryValue({ field: 'manager_device_buffer_bytes' }),
        trackedRuntimeCpuBytes: memoryValue({ field: 'tracked_runtime_cpu_bytes' }), trackedRuntimeNonCpuBytes: memoryValue({ field: 'tracked_runtime_non_cpu_bytes' }),
        trackedRuntimeUnknownBytes: memoryValue({ field: 'tracked_runtime_unknown_bytes' }), saturated: Number(core.getField(memoryRecord, memory, 'saturated')) === 1,
      },
      requested: {
        nThreads: Number(parameter({ field: 'n_threads' })), computeBackend: parameterText({ field: 'backend' }), paramsBackend: parameterText({ field: 'params_backend' }),
        maxVram: parameterText({ field: 'max_vram' }), flashAttention: Number(parameter({ field: 'flash_attn' })) === 1,
        diffusionFlashAttention: Number(parameter({ field: 'diffusion_flash_attn' })) === 1,
        bf16WeightType: bf16Type === core.constant('SD_TYPE_F32') ? 'f32' : bf16Type === core.constant('SD_TYPE_F16') ? 'f16' : 'other',
        conditioningCacheSize: Number(parameter({ field: 'conditioning_cache_size' })),
      },
    }) };
  } catch (error) {
    poisoned = core.busy || imageErrorContext({ error }).errorType === 'wasm-trap';
    result = { status: 'failed', disposition: poisoned ? 'retire-worker' : 'retryable', message: (error instanceof Error ? error.message : String(error)).slice(0, 1024) };
  }
  if (!poisoned) {
    try {
      for (const pointer of allocations.reverse()) core.free(pointer);
    } catch (error) {
      result = { status: 'failed', disposition: 'retire-worker', message: (error instanceof Error ? error.message : String(error)).slice(0, 1024) };
    }
  }
  return result;
}

export const TEST_ONLY = {
};
