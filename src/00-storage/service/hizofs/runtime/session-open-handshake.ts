import type { CrossRealmLockCoordinator } from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";

/**
 * Keeps password derivation and tree verification outside both the shared
 * authority lease and the long-lived runtime-owner lease. After verification,
 * runtime ownership is acquired before the final authority recheck so a stale
 * capture cannot become visible while another realm still owns the container.
 */
export async function openRuntimeSessionWithAuthorityHandshake<Captured, Verified, SessionOwner, Session>({
  acquireSessionOwner,
  captureAuthority,
  coordinator,
  createSession,
  recheckAuthority,
  releaseSessionOwner,
  verifyCapturedAuthority,
}: {
  acquireSessionOwner: () => Promise<SessionOwner>;
  captureAuthority: () => Promise<Captured>;
  coordinator: CrossRealmLockCoordinator;
  createSession: ({ captured, sessionOwner, verified }: {
    captured: Captured;
    sessionOwner: SessionOwner;
    verified: Verified;
  }) => Session;
  recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
  releaseSessionOwner: ({ sessionOwner }: { sessionOwner: SessionOwner }) => Promise<void>;
  verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<Verified>;
}): Promise<Session> {
  const captured = await coordinator.runAuthorityRead({ operation: captureAuthority });
  const verified = await verifyCapturedAuthority({ captured });
  const sessionOwner = await acquireSessionOwner();
  try {
    return await coordinator.runAuthorityRead({ operation: async () => {
      await recheckAuthority({ captured });
      return createSession({ captured, sessionOwner, verified });
    } });
  } catch (cause: unknown) {
    try {
      await releaseSessionOwner({ sessionOwner });
    } catch (cleanupCause: unknown) {
      throw new AggregateError(
        [cause, cleanupCause],
        "runtime session authority rejection and owner cleanup both failed",
      );
    }
    throw cause;
  }
}



export async function tryOpenRuntimeSessionWithAuthorityHandshake<Captured, Verified, SessionOwner, Session>({
  captureAuthority,
  coordinator,
  createSession,
  recheckAuthority,
  releaseSessionOwner,
  tryAcquireSessionOwner,
  verifyCapturedAuthority,
}: {
  captureAuthority: () => Promise<Captured>;
  coordinator: CrossRealmLockCoordinator;
  createSession: ({ captured, sessionOwner, verified }: {
    captured: Captured;
    sessionOwner: SessionOwner;
    verified: Verified;
  }) => Session;
  recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
  releaseSessionOwner: ({ sessionOwner }: { sessionOwner: SessionOwner }) => Promise<void>;
  tryAcquireSessionOwner: () => Promise<SessionOwner | undefined>;
  verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<Verified>;
}): Promise<Session | undefined> {
  const captured = await coordinator.runAuthorityRead({ operation: captureAuthority });
  const verified = await verifyCapturedAuthority({ captured });
  const sessionOwner = await tryAcquireSessionOwner();
  if (sessionOwner === undefined) return undefined;
  try {
    return await coordinator.runAuthorityRead({ operation: async () => {
      await recheckAuthority({ captured });
      return createSession({ captured, sessionOwner, verified });
    } });
  } catch (cause: unknown) {
    try {
      await releaseSessionOwner({ sessionOwner });
    } catch (cleanupCause: unknown) {
      throw new AggregateError(
        [cause, cleanupCause],
        "runtime session authority rejection and non-blocking owner cleanup both failed",
      );
    }
    throw cause;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
