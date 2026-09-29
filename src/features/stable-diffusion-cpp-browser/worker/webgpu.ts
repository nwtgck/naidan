import { createCoreWebGpuNavigator } from '@/features/llama-cpp-browser/runtime/webgpu-dispatch';
import type { createImageTrace } from '@/features/stable-diffusion-cpp-browser/diagnostics';

/** The published image factory reads the Worker's navigator directly (unlike
 * the llama factory's lexical injection). Install only its acquisition method,
 * before loading the single-use runtime, and restore it on exit. Never modify
 * device limits, GPU prototypes, installed artifacts, tensor data or precision.
 * Dispatch adaptation is mandatory even with diagnostics disabled. */
export function installImageWebGpu({ gpu, emit }: {
  gpu: GPU, emit: ReturnType<typeof createImageTrace>['emit'],
}): { dispose(): void } {
  const before = Object.getOwnPropertyDescriptor(gpu, 'requestAdapter');
  const scoped = createCoreWebGpuNavigator({ navigator: { gpu }, report: ({ axis, count, limit, chunks }) => {
    emit({ event: 'gpu', stage: 'generation', message: 'Oversized WebGPU dispatch split without changing logical coordinates', fields: { axis, count, limit, chunks } });
  } });
  if (!scoped) throw new Error('Image WebGPU dispatch adapter is unavailable');
  const requestAdapter = scoped.gpu.requestAdapter;
  // Fail before native execution if the required boundary cannot be installed.
  // A silently unadapted dispatch would abort Wasm from an asynchronous GPU callback.
  Object.defineProperty(gpu, 'requestAdapter', { configurable: true, writable: true, value: requestAdapter });
  let disposed = false;
  return { dispose() {
    if (disposed) return;
    disposed = true;
    if (before) Object.defineProperty(gpu, 'requestAdapter', before);
    else Reflect.deleteProperty(gpu, 'requestAdapter');
  } };
}
export const TEST_ONLY = {
};
