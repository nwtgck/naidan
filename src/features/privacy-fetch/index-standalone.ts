export { privacyFetch, privacyFetchStream } from './client-standalone';
export type {
  PrivacyFetchStreamResponse,
  PrivacyFetchHeaderEntries,
  PrivacyFetchRequest,
  PrivacyFetchResponse,
} from './types';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
