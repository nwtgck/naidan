export {
  FAKE_LM_ENDPOINT_HOSTNAME,
  FAKE_LM_ENDPOINT_URL,
  isFakeLmEndpointUrl,
} from '@/features/fake-lm/api/fakeLmEndpointUrl';
export { createFakeLmFetchForEndpoint } from '@/features/fake-lm/hosted/fakeLmFetchForEndpoint';
export {
  useFakeLmDebugMode,
  type FakeLmDebugModeAvailability,
  type FakeLmDebugModeStatus,
} from '@/features/fake-lm/runtime/fakeLmDebugMode';
export { preloadFakeLmLanguagePacks } from '@/features/fake-lm/core/lexiconLoader';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
