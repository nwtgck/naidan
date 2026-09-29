import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';

/**
 * Production cache-only model load fallback order.
 *
 * Download Verification imports this same sequence so its candidate probes do
 * not silently drift from the user-facing Production loader.
 */
export const TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES = [
  { device: 'webgpu', dtype: 'q4f16' },
  { device: 'webgpu', dtype: 'q4' },
  { device: 'wasm', dtype: 'q4' },
] as const satisfies readonly TransformersJsProductionInvestigationCandidate[];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
