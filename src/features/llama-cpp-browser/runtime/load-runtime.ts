import { promiseAllKeyed } from '@/utils/promise';
import { loadWasmBinary, preloadCoreModule } from '@/features/llama-cpp-browser/runtime/artifacts';
import { createCore, type Core } from './core';
import { LlamaCppBrowserError, usesWebGpu, type LlamaCppProfile } from '@/features/llama-cpp-browser/types';
import { logDiagnostic, logNativeDiagnostic } from '@/features/llama-cpp-browser/debug-log';

type SettledInput<T> = { status: 'ready', value: T } | { status: 'failed', error: unknown };

// Both non-native inputs must settle before returning ownership on failure.
// Keep a failed branch observed even while the other import/download is pending.
async function settleInput<T>({ operation }: { operation: () => Promise<T> }): Promise<SettledInput<T>> {
  try {
    return { status: 'ready', value: await operation() };
  } catch (error) {
    return { status: 'failed', error };
  }
}

function requireInput<T>({ input }: { input: SettledInput<T> }): T {
  switch (input.status) {
  case 'ready': return input.value;
  case 'failed': throw input.error;
  default: { const exhaustive: never = input; throw new Error(String(exhaustive)); }
  }
}

export async function loadRuntime({ profile, assetBaseURL }: { profile: LlamaCppProfile, assetBaseURL: string | undefined }): Promise<Core> {
  const wasmFeatures: object = WebAssembly;
  if (usesWebGpu({ profile }) && (typeof navigator === 'undefined' || !navigator.gpu)) {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  if ((profile === 'webgpu-wasm64-jspi' || profile === 'webgpu-wasm32-jspi') && (!('promising' in wasmFeatures) || typeof wasmFeatures.promising !== 'function' || !('Suspending' in wasmFeatures) || typeof wasmFeatures.Suspending !== 'function')) {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  const inputs = await promiseAllKeyed({
    binary: settleInput({ operation: () => loadWasmBinary({ profile, assetBaseURL }) }),
    factory: settleInput({ operation: () => preloadCoreModule({ profile, baseURL: assetBaseURL }) }),
  });
  // Binary failures retain the serial path's precedence. Neither branch has
  // created native memory, a backend, or a GPU device at this point.
  const wasmBinary = requireInput({ input: inputs.binary });
  requireInput({ input: inputs.factory });
  const core = await createCore({
    profile,
    baseURL: assetBaseURL,
    moduleOptions: {
      wasmBinary,
      // Native messages can contain prompts, paths and arbitrary GGUF metadata.
      print() {},
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten logging callback ABI.
      printErr(message) {
        logNativeDiagnostic({ message });
      },
    },
  });
  await core.api.llama_backend_init();
  if (usesWebGpu({ profile })) {
    const device = await core.api.ggml_backend_dev_by_type(core.constant({ name: 'GGML_BACKEND_DEVICE_TYPE_GPU' }));
    if (device === 0n) throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  logDiagnostic({ diagnostic: { event: 'runtime-ready', profile } });
  return core;
}
export const TEST_ONLY = {
};
