/** Synthetic inputs only; no real model or inference is represented by these fixtures. */
import type { Artifact, Parameters, Request } from './types';
export function ggufFile(): File {
  const header = new Uint8Array(24);
  new DataView(header.buffer).setUint32(0, 0x46554747, true);
  new DataView(header.buffer).setUint32(4, 3, true);
  return new File([header], 'model.gguf');
}
export function artifactFixture(): Artifact {
  const prefix = `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/`;
  return { profile: 'webgpu-wasm32-asyncify', modulePath: prefix + 'webgpu-wasm32-asyncify/core.mjs', wasmPath: prefix + 'webgpu-wasm32-asyncify/core.wasm.gz', helpersPath: prefix + 'examples/runtime/index.mjs', schemaSha256: '1'.repeat(64), wasmBytes: 8, wasmSha256: '0'.repeat(64) };
}
export function parametersFixture(): Parameters {
  return { prompt: 'a small tree', negativePrompt: '', width: 256, height: 256, steps: 20, guidance: 7, seed: '42', sampler: 'auto', scheduler: 'auto', distilledGuidance: 3.5, vaeTiling: true, vaeTileSize: 32, flashAttention: false, qwenVaePolicy: 'bounded', conditioningCacheSize: 0, modelArguments: '' };
}
export function requestFixture(): Request {
  return { runId: 0, sessionId: '', preview: { enabled: false, interval: 2, mode: 'projection', maxEdge: 256 }, artifact: artifactFixture(), baseUrl: 'https://naidan.example/app/', models: [{ slot: 'model', file: ggufFile() }], parameters: parametersFixture(), weightResidency: 'auto', gpuBudgetMiB: undefined };
}
export const TEST_ONLY = {
};
