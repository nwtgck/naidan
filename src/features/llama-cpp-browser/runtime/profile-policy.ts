import { runtimeOptionsSchema, type RuntimeOptions } from '@/features/llama-cpp-browser/types';
export const selectableProfiles: readonly RuntimeOptions['profile'][] = ['auto', 'webgpu-wasm64-jspi', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify', 'cpu-wasm64', 'cpu-wasm32'] as const;
export function defaultRuntimeOptions(): RuntimeOptions {
  return { profile: 'auto' };
}
export function parseRuntimeOptions({ options }: { options: RuntimeOptions }): RuntimeOptions {
  return runtimeOptionsSchema.parse(options);
}
export const TEST_ONLY = {
};
