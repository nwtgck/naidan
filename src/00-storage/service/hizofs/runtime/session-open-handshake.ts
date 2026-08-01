import type { CrossRealmLockCoordinator } from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";

/**
 * Keeps password derivation and tree verification outside the shared authority
 * lease. The second short lease rejects a stale capture before a session or
 * reader pin becomes visible, so a long open does not stop publication.
 */
export async function openRuntimeSessionWithAuthorityHandshake<Captured, Verified, Session>({
  captureAuthority,
  coordinator,
  createSession,
  recheckAuthority,
  verifyCapturedAuthority,
}: {
  captureAuthority: () => Promise<Captured>;
  coordinator: CrossRealmLockCoordinator;
  createSession: ({ captured, verified }: {
    captured: Captured;
    verified: Verified;
  }) => Session;
  recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
  verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<Verified>;
}): Promise<Session> {
  const captured = await coordinator.runAuthorityRead({ operation: captureAuthority });
  const verified = await verifyCapturedAuthority({ captured });
  return await coordinator.runAuthorityRead({ operation: async () => {
    await recheckAuthority({ captured });
    return createSession({ captured, verified });
  } });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
