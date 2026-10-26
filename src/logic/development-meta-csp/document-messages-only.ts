import { getDevelopmentMetaCspReadOnlyOwnerForMessagesOnly } from './owner';
import type { AppliedDevelopmentMetaCspForDocumentMessagesOnly } from './types';

/** Read-only bridge. A message must never install, remove, or save a policy. */
export function getAppliedDevelopmentMetaCspForDocumentMessagesOnly(): readonly AppliedDevelopmentMetaCspForDocumentMessagesOnly[] | undefined {
  return getDevelopmentMetaCspReadOnlyOwnerForMessagesOnly().getAppliedForDocumentMessagesOnly();
}

export function getDevelopmentMetaCspForNextPrivacyBrokerRequestHintsOnly() {
  return getDevelopmentMetaCspReadOnlyOwnerForMessagesOnly().getPrivacyBrokerForNextRequestHintsOnly();
}

export function subscribeDevelopmentMetaCspMessagesOnly({ listener }: { listener(): void }): (() => void) | undefined {
  return getDevelopmentMetaCspReadOnlyOwnerForMessagesOnly().subscribe({ listener });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
