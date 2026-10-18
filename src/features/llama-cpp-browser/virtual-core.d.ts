declare module 'virtual:llama-cpp-browser-core/cpu-wasm32' {
  export { default } from 'llama-cpp-browser-core/profiles/cpu-wasm32/browser/core.mjs';
}
declare module 'virtual:llama-cpp-browser-core/webgpu-wasm64-jspi-gpu-profile' {
  export { default } from 'llama-cpp-browser-core/profiles/webgpu-wasm64-jspi/browser/core.mjs';
}
declare module 'virtual:llama-cpp-browser-core/webgpu-wasm32-asyncify' {
  export { default } from 'llama-cpp-browser-core/profiles/webgpu-wasm32-asyncify/browser/core.mjs';
}
declare module 'virtual:llama-cpp-browser-core/webgpu-wasm64-jspi' {
  export { default } from 'llama-cpp-browser-core/profiles/webgpu-wasm64-jspi/browser/core.mjs';
}
declare module 'virtual:llama-cpp-browser-core/webgpu-wasm32-jspi' {
  export { default } from 'llama-cpp-browser-core/profiles/webgpu-wasm32-jspi/browser/core.mjs';
}

declare module 'virtual:llama-cpp-browser-core/availability' {
  export const gpuProfilingAvailable: boolean;
}
