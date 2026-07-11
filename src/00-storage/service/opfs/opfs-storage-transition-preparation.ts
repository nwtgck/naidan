type OpfsStorageTransitionPreparation = () => Promise<void>;
type OpfsExternalTransitionStarting = () => Promise<void>;
export type OpfsExternalTransitionSettlement =
  | 'completed'
  | 'failed'
  | 'preparation_failed';
type OpfsExternalTransitionSettled = ({ settlement }: {
  settlement: OpfsExternalTransitionSettlement,
}) => void;

interface OpfsStorageTransitionRegistration {
  readonly externalTransitionStarting: OpfsExternalTransitionStarting,
  readonly prepare: OpfsStorageTransitionPreparation,
  readonly externalTransitionSettled: OpfsExternalTransitionSettled,
}

const registrations = new Set<OpfsStorageTransitionRegistration>();

/**
 * Registers application-owned lifecycle work around an external OPFS storage
 * transition. Storage owns synchronization and shared-lock release, while the
 * application owns presentation and cleanup for Chat, Wesh, and File Explorer.
 */
export function registerOpfsStorageTransitionPreparation({
  externalTransitionStarting,
  prepare,
  externalTransitionSettled,
}: {
  externalTransitionStarting: OpfsExternalTransitionStarting,
  prepare: OpfsStorageTransitionPreparation,
  externalTransitionSettled: OpfsExternalTransitionSettled,
}): () => void {
  const registration = {
    externalTransitionStarting,
    prepare,
    externalTransitionSettled,
  };
  registrations.add(registration);
  return () => {
    registrations.delete(registration);
  };
}

export async function notifyRegisteredOpfsExternalTransitionStarting(): Promise<void> {
  for (const registration of registrations) {
    await registration.externalTransitionStarting();
  }
}

export async function prepareRegisteredOpfsStorageTransition(): Promise<void> {
  for (const registration of registrations) {
    await registration.prepare();
  }
}

export function notifyRegisteredOpfsExternalTransitionSettled({
  settlement,
}: {
  settlement: OpfsExternalTransitionSettlement,
}): void {
  for (const registration of registrations) {
    registration.externalTransitionSettled({ settlement });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  registrations,
};
