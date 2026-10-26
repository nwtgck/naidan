import { getDevelopmentMetaCspPrivacyBrokerSyncOwnerNotForSecurity } from './owner';

/** Explicit development control, never a decision about ordinary requests. */
export function getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity() {
  return getDevelopmentMetaCspPrivacyBrokerSyncOwnerNotForSecurity();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
