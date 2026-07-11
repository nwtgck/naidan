type OpfsStorageTransitionPreparation = () => Promise<void>;
type OpfsExternalTransitionPrepared = () => void;

interface OpfsStorageTransitionRegistration {
  readonly prepare: OpfsStorageTransitionPreparation,
  readonly externalTransitionPrepared: OpfsExternalTransitionPrepared,
}

const registrations = new Set<OpfsStorageTransitionRegistration>();

/**
 * Registers application-owned cleanup that must finish before an OPFS storage
 * session releases its shared Web Lock for an encryption transition.
 *
 * The storage layer owns the synchronization point but does not import Wesh,
 * File Explorer, chat processing, or other application features. Callers may
 * keep those features code-split by registering callbacks that import them
 * only when a transition is requested.
 */
export function registerOpfsStorageTransitionPreparation({
  prepare,
  externalTransitionPrepared,
}: {
  prepare: OpfsStorageTransitionPreparation,
  externalTransitionPrepared: OpfsExternalTransitionPrepared,
}): () => void {
  const registration = {
    prepare,
    externalTransitionPrepared,
  };
  registrations.add(registration);
  return () => {
    registrations.delete(registration);
  };
}

export async function prepareRegisteredOpfsStorageTransition(): Promise<void> {
  for (const registration of registrations) {
    await registration.prepare();
  }
}

export function notifyRegisteredOpfsExternalTransitionPrepared(): void {
  for (const registration of registrations) {
    registration.externalTransitionPrepared();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  registrations,
};
