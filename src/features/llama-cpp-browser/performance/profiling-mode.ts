import { gpuProfilingProfile } from '@/features/llama-cpp-browser/types';
import type { ProfileCapabilities, ProfileUnavailableReason } from '@/features/llama-cpp-browser/runtime/profile-capabilities';

/** Hosted includes Vite development; standalone must never fetch diagnostic Wasm. */
export function buildAllowsGpuProfiling(): boolean {
  return __BUILD_MODE_IS_HOSTED__;
}

export function gpuProfilingUnavailableReason({ hosted, capabilities }: {
  hosted: boolean, capabilities: ProfileCapabilities | undefined,
}): ProfileUnavailableReason | undefined {
  if (!hosted) {
    return 'standalone';
  }
  const entry = capabilities?.profiles.find(entry => entry.profile === gpuProfilingProfile);
  if (!entry) {
    return capabilities ? 'profiling-artifact' : 'worker';
  }
  switch (entry.status) {
  case 'unavailable': return entry.reason;
  case 'available': break;
  default: {
    const exhaustive: never = entry;
    throw new Error(String(exhaustive));
  }
  }
  // Both modes use the same ordinary wasm64/JSPI reference implementation.
  const ordinary = capabilities?.profiles.find(entry => entry.profile === 'webgpu-wasm64-jspi');
  switch (ordinary?.status) {
  case 'available': return undefined;
  case 'unavailable': return ordinary.reason;
  case undefined: return 'worker';
  default: {
    const exhaustive: never = ordinary;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
