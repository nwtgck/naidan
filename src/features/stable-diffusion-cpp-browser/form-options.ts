/** Presentation choices only. No validation, device probing or runtime imports. */
export const profileOptions = ['webgpu-wasm32-asyncify', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi'] as const;
export const samplerOptions = ['auto', 'euler', 'euler_a', 'heun', 'dpm2', 'dpm++2m', 'lcm'] as const;
export const schedulerOptions = ['auto', 'discrete', 'karras', 'exponential', 'simple', 'sgm_uniform'] as const;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
