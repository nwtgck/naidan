import { LlamaCppBrowserError, runtimeOptionsSchema, type RuntimeOptions } from '@/features/llama-cpp-browser/types';
export const selectableProfiles: readonly RuntimeOptions['profile'][] = ['auto', 'webgpu-wasm64-jspi', 'webgpu-wasm32-jspi'] as const;

export function defaultRuntimeOptions(): RuntimeOptions {
  return { profile: 'auto' };
}

export function parseRuntimeOptions({ options }: { options: RuntimeOptions }): RuntimeOptions {
  const accepted = runtimeOptionsSchema.parse(options);
  switch (accepted.profile) {
  case 'auto':
  case 'webgpu-wasm64-jspi':
  case 'webgpu-wasm32-jspi': return accepted;
  case 'cpu-wasm32':
  case 'webgpu-wasm64-jspi-gpu-profile':
  case 'webgpu-wasm32-asyncify': throw new LlamaCppBrowserError({ code: 'unavailable' });
  default: {
    const exhaustive: never = accepted.profile;
    throw new Error(`Unknown runtime profile: ${exhaustive}`);
  }
  }
}


export function parsePerformanceRuntimeOptions({ options }: { options: RuntimeOptions }): RuntimeOptions {
  return parseRuntimeOptions({ options });
}

export const TEST_ONLY = {
};
