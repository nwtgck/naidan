import type { ImageEngineSnapshot } from '@/features/stable-diffusion-cpp-browser/engine-state';

export function engineSnapshotFixture(): ImageEngineSnapshot {
  return {
    type: 'naidan-image-engine-snapshot-v1', collectedAt: 1700000000000, profile: 'webgpu-wasm64-jspi', source: 'a'.repeat(40), modelVersion: 'Fixture model',
    wasmCapacityBytes: 1048576, fileReadCacheBytes: 65536,
    runtime: { nThreads: 1, runnersReady: true, eagerLoad: true, mmap: false, prefetch: true, segmentedCompute: true, autoFit: false },
    memory: { registeredTensorCount: '100', registeredTensorBytes: '9007199254740993', managerHostBufferCount: '1', managerHostBufferBytes: '1000',
      managerDeviceBufferCount: '2', managerDeviceBufferBytes: '2000', trackedRuntimeCpuBytes: '3000', trackedRuntimeNonCpuBytes: '4000',
      trackedRuntimeUnknownBytes: '0', saturated: false },
    requested: { nThreads: -1, computeBackend: 'WebGPU', paramsBackend: 'cpu', maxVram: '', flashAttention: false,
      diffusionFlashAttention: false, bf16WeightType: 'f32', conditioningCacheSize: 1 },
  };
}

export const TEST_ONLY = {
};
