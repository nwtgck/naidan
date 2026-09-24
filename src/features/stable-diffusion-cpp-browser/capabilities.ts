import type { Artifact } from './types';
/** Local feature probes only: never fetch a runtime, create a Worker, or request a GPU. */
export function supportsMemory64(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]));
  } catch {
    return false;
  }
}
export function supportsJspi(): boolean {
  return typeof WebAssembly !== 'undefined' && 'Suspending' in WebAssembly && 'promising' in WebAssembly;
}
export function initialProfile(): Artifact['profile'] {
  if (supportsJspi()) return supportsMemory64() ? 'webgpu-wasm64-jspi' : 'webgpu-wasm32-jspi';
  return 'webgpu-wasm32-asyncify';
}
export const TEST_ONLY = {
};
