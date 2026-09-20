import { LlamaCppBrowserError, type LlamaCppProfile, type RuntimeOptions } from '@/features/llama-cpp-browser/types';

// An unexported memory64 with one page. Validation does not allocate model memory.
const memory64Probe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]);

export async function resolveRuntimeProfile({ profile }: { profile: RuntimeOptions['profile'] }): Promise<LlamaCppProfile> {
  switch (profile) {
  case 'cpu-wasm32': case 'cpu-wasm64': case 'webgpu-wasm64-jspi': case 'webgpu-wasm32-asyncify':
    // Explicit choices remain explicit; model/load failures are not fallback triggers.
    return profile;
  case 'auto': break;
  default: { const exhaustive: never = profile; throw new Error(`Unhandled profile: ${exhaustive}`); }
  }
  if (typeof WebAssembly === 'undefined') throw new LlamaCppBrowserError({ code: 'unavailable' });
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
        // Asyncify is compiled into the wasm32 artifact and needs no JSPI or memory64 support.
        return memory64 && jspi ? 'webgpu-wasm64-jspi' : 'webgpu-wasm32-asyncify';
      }
    } catch {
      // Unavailable/blocked adapters leave the CPU path available. Do not log raw errors.
    }
  }
  return memory64 ? 'cpu-wasm64' : 'cpu-wasm32';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
