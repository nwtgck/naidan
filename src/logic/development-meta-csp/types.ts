import type { ParsedCsp } from '@/utils/csp';

export type DevelopmentMetaCspInstallationNotForSecurity =
  | Readonly<{ kind: 'not-added' }>
  | Readonly<{
    kind: 'added' | 'partly-added' | 'failed',
    serialized: string,
    policies: readonly string[],
    source: 'saved-setting' | 'developer-action',
  }>;

export type DevelopmentMetaCspAdditionNotForSecurity = Readonly<{
  serialized: string,
  policies: readonly string[],
  source: 'saved-setting' | 'developer-action',
}>;

export type DevelopmentMetaCspPrivacyBrokerStateNotForSecurity = Readonly<{
  kind: 'not-created' | 'pending' | 'confirmed' | 'unavailable',
  sessionId: string | undefined,
  syncId: string | undefined,
  requestedPolicyCount: number,
  confirmedPolicyCount: number,
  reason: 'send-failed' | 'installation-failed' | 'invalid-result' | undefined,
}>;

export type DevelopmentMetaCspSnapshotNotForSecurity = Readonly<{
  preparation: 'idle' | 'preparing' | 'ready' | 'unavailable',
  reason: 'recovery-not-resident' | 'parser-unavailable' | 'invalid-policy' | 'setting-changed' | 'installation-failed' | undefined,
  installation: DevelopmentMetaCspInstallationNotForSecurity,
  additions: readonly DevelopmentMetaCspAdditionNotForSecurity[],
  diagnostics: 'complete' | 'unavailable',
  privacyBroker: DevelopmentMetaCspPrivacyBrokerStateNotForSecurity,
}>;

/** Cached parse for realm-specific UI messages; never an execution decision. */
export type AppliedDevelopmentMetaCspForUiMessagesOnly = Readonly<{
  serialized: string,
  parsed: ParsedCsp,
}>;

export type AppliedDevelopmentMetaCspForDocumentMessagesOnly = AppliedDevelopmentMetaCspForUiMessagesOnly;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
