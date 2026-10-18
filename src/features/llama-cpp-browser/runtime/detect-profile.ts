import { gpuProfilingAvailable } from 'virtual:llama-cpp-browser-core/availability';
import { checkJspi, checkStorage, probeGpuCapabilities, supportsMemory64 } from './capability-probes';
import { profileCapabilitiesSchema, type ProfileCapabilities, type ProfileUnavailableReason } from './profile-capabilities';
import { profileSchema } from '@/features/llama-cpp-browser/types';
import { LlamaCppBrowserError, type LlamaCppProfile, type RuntimeOptions } from '@/features/llama-cpp-browser/types';

// An unexported memory64 with one page. Validation does not allocate model memory.
const memory64Probe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]);

export async function resolveRuntimeProfile({ profile }: { profile: RuntimeOptions['profile'] }): Promise<LlamaCppProfile> {
  switch (profile) {
  case 'cpu-wasm32': case 'webgpu-wasm64-jspi-gpu-profile': case 'webgpu-wasm64-jspi': case 'webgpu-wasm32-jspi': case 'webgpu-wasm32-asyncify':
    // Explicit choices remain explicit; model/load failures are not fallback triggers.
    return profile;
  case 'auto': break;
  default: {
    const exhaustive: never = profile;
    throw new Error(`Unhandled profile: ${exhaustive}`);
  }
  }
  if (typeof WebAssembly === 'undefined') {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  let memory64 = false;
  try {
    memory64 = WebAssembly.validate(memory64Probe);
  } catch {
    // Older engines may reject proposal flags rather than return false.
  }
  const wasm: object = WebAssembly;
  const jspi = 'promising' in wasm && typeof wasm.promising === 'function'
    && 'Suspending' in wasm && typeof wasm.Suspending === 'function';
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      // The pinned backend requires shader-f16. Merely exposing navigator.gpu
      // does not mean an adapter with the required features can be obtained.
      if (adapter?.features.has('shader-f16')) {
        // Prefer the larger address space when available, then JSPI over Asyncify.
        if (jspi) {
          return memory64 ? 'webgpu-wasm64-jspi' : 'webgpu-wasm32-jspi';
        }
        return 'webgpu-wasm32-asyncify';
      }
    } catch {
      // Unavailable/blocked adapters leave the CPU path available. Do not log raw errors.
    }
  }
  return 'cpu-wasm32';
}

/** Report browser capabilities without importing an inference runtime or a model. */
export async function probeRuntimeProfiles(): Promise<ProfileCapabilities> {
  const memory64 = supportsMemory64();
  let sharedReason: ProfileUnavailableReason | undefined;
  if (typeof WebAssembly === 'undefined') {
    sharedReason = 'wasm';
  } else {
    try {
      await checkStorage();
    } catch {
      sharedReason = 'storage';
    }
  }
  let jspi = false;
  if (!sharedReason) {
    try {
      await checkJspi();
      jspi = true;
    } catch { /* CPU and Asyncify remain available. */ }
  }
  const gpu = sharedReason ? undefined : await probeGpuCapabilities();
  const gpuReason = gpu?.reason;
  const profiles: ProfileCapabilities['profiles'] = profileSchema.options.map(profile => {
    let reason = sharedReason;
    if (!reason) {
      switch (profile) {
      case 'cpu-wasm32': break;
      case 'webgpu-wasm64-jspi-gpu-profile': reason = !gpuProfilingAvailable ? 'profiling-artifact'
        : gpuReason ?? (!memory64 ? 'memory64' : !jspi ? 'jspi' : !gpu?.timestampQuery ? 'timestamp-query' : undefined);
        break;
      case 'webgpu-wasm32-asyncify': reason = gpuReason;
        break;
      case 'webgpu-wasm32-jspi': reason = gpuReason ?? (jspi ? undefined : 'jspi');
        break;
      case 'webgpu-wasm64-jspi': reason = gpuReason ?? (!memory64 ? 'memory64' : jspi ? undefined : 'jspi');
        break;
      default: {
        const exhaustive: never = profile;
        throw new Error(`Unhandled profile: ${exhaustive}`);
      }
      }
    }
    return reason ? { profile, status: 'unavailable', reason } : { profile, status: 'available' };
  });
  return profileCapabilitiesSchema.parse({ profiles, recommended: profiles.find(entry => entry.status === 'available' && entry.profile !== 'webgpu-wasm64-jspi-gpu-profile')?.profile });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
