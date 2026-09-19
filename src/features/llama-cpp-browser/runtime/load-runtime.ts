import { createCore, type Core } from 'llama-cpp-browser-core';
import { LlamaCppBrowserError, usesWebGpu, type LlamaCppProfile } from '@/features/llama-cpp-browser/types';
import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';

export async function loadRuntime({ profile, assetBaseURL }: { profile: LlamaCppProfile, assetBaseURL: string }): Promise<Core> {
  const wasmFeatures: object = WebAssembly;
  if (usesWebGpu({ profile }) && (!navigator.gpu || !('promising' in wasmFeatures) || typeof wasmFeatures.promising !== 'function')) {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  const response = await fetch(new URL(`${profile}/core.wasm.gz`, assetBaseURL));
  if (!response.ok || !response.body) throw new LlamaCppBrowserError({ code: 'runtime-error' });
  const wasmBinary = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const core = await createCore({
    profile,
    baseURL: assetBaseURL,
    moduleOptions: {
      wasmBinary,
      // Native messages can contain prompts, paths and arbitrary GGUF metadata.
      print() {}, printErr() {},
    },
  });
  await core.api.llama_backend_init();
  if (usesWebGpu({ profile })) {
    const device = await core.api.ggml_backend_dev_by_type(core.constant('GGML_BACKEND_DEVICE_TYPE_GPU'));
    if (device === 0n) throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  logDiagnostic({ diagnostic: { event: 'runtime-ready', profile } });
  return core;
}
export const TEST_ONLY = {
};
