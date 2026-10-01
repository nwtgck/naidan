import { promiseAllKeyed } from '@/utils/promise';
import { loadWasmBinary, preloadCoreModule } from '@/features/llama-cpp-browser/runtime/artifacts';
import { createCore, type Core } from './core';
import { LlamaCppBrowserError, usesWebGpu, type LlamaCppProfile } from '@/features/llama-cpp-browser/types';
import { logDiagnostic, logNativeDiagnostic } from '@/features/llama-cpp-browser/debug-log';

// Invoke both inputs immediately and turn synchronous throws into rejections.
// These operations only acquire bytes/factories; neither creates native state.
async function acquireInput<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
  return operation();
}

export async function loadRuntime({ profile, assetBaseURL }: { profile: LlamaCppProfile, assetBaseURL: string | undefined }): Promise<Core> {
  const wasmFeatures: object = WebAssembly;
  if (usesWebGpu({ profile }) && (typeof navigator === 'undefined' || !navigator.gpu)) {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  if ((profile === 'webgpu-wasm64-jspi' || profile === 'webgpu-wasm32-jspi') && (!('promising' in wasmFeatures) || typeof wasmFeatures.promising !== 'function' || !('Suspending' in wasmFeatures) || typeof wasmFeatures.Suspending !== 'function')) {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  const acquisition = new AbortController();
  const { binary: wasmBinary } = await promiseAllKeyed({
    binary: acquireInput({ operation: () => loadWasmBinary({ profile, assetBaseURL, signal: acquisition.signal }) }),
    factory: acquireInput({ operation: () => preloadCoreModule({ profile, baseURL: assetBaseURL }) }),
  }).catch(error => {
    // Do not hide a known startup failure behind a stalled sibling. Stop the
    // byte download; the import remains observed and can never instantiate a
    // late native module. The first observed failure remains the owning error.
    acquisition.abort();
    throw error;
  });
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
