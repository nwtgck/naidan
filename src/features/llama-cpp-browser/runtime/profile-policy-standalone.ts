import { LlamaCppBrowserError, runtimeOptionsSchema, type RuntimeOptions } from '@/features/llama-cpp-browser/types';
export const selectableProfiles: readonly RuntimeOptions['profile'][] = ['webgpu-wasm64-jspi'] as const;
export function defaultRuntimeOptions(): RuntimeOptions {
  return { profile: 'webgpu-wasm64-jspi' };
}
export function parseRuntimeOptions({ options }: { options: RuntimeOptions }): RuntimeOptions {
  const accepted = runtimeOptionsSchema.parse(options);
  switch (accepted.profile) {
  case 'webgpu-wasm64-jspi': return accepted;
  case 'auto':
  case 'cpu-wasm32':
  case 'cpu-wasm64':
  case 'webgpu-wasm32-jspi':
  case 'webgpu-wasm32-asyncify': throw new LlamaCppBrowserError({ code: 'unavailable' });
  default: {
    const exhaustive: never = accepted.profile;
    throw new Error(`Unknown runtime profile: ${exhaustive}`);
  }
  }
}
export const TEST_ONLY = {
};
