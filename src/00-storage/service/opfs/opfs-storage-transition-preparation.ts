type OpfsStorageTransitionPreparation = () => Promise<void>;
type OpfsLocalTransitionStarting = () => void;
type OpfsExternalTransitionStarting = () => Promise<void>;
export type OpfsExternalTransitionSettlement =
  | 'completed'
  | 'failed'
  | 'preparation_failed';
type OpfsTransitionSettled = ({ settlement }: {
  settlement: OpfsExternalTransitionSettlement,
}) => void;

interface OpfsStorageTransitionRegistration {
  readonly localTransitionStarting: OpfsLocalTransitionStarting,
  readonly externalTransitionStarting: OpfsExternalTransitionStarting,
  readonly prepare: OpfsStorageTransitionPreparation,
  readonly localTransitionSettled: OpfsTransitionSettled,
  readonly externalTransitionSettled: OpfsTransitionSettled,
}

const registrations = new Set<OpfsStorageTransitionRegistration>();

/**
 * Registers application-owned lifecycle work around an external OPFS storage
 * transition. Storage owns synchronization and shared-lock release, while the
 * application owns presentation and cleanup for Chat, Wesh, and File Explorer.
 */
export function registerOpfsStorageTransitionPreparation({
  localTransitionStarting,
  externalTransitionStarting,
  prepare,
  localTransitionSettled,
  externalTransitionSettled,
}: {
  localTransitionStarting: OpfsLocalTransitionStarting,
  externalTransitionStarting: OpfsExternalTransitionStarting,
  prepare: OpfsStorageTransitionPreparation,
  localTransitionSettled: OpfsTransitionSettled,
  externalTransitionSettled: OpfsTransitionSettled,
}): () => void {
  const registration = {
    localTransitionStarting,
    externalTransitionStarting,
    prepare,
    localTransitionSettled,
    externalTransitionSettled,
  };
  registrations.add(registration);
  return () => {
    registrations.delete(registration);
  };
}

export function notifyRegisteredOpfsLocalTransitionStarting(): void {
  for (const registration of registrations) {
    registration.localTransitionStarting();
  }
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

export function notifyRegisteredOpfsLocalTransitionSettled({
  settlement,
}: {
  settlement: OpfsExternalTransitionSettlement,
}): void {
  for (const registration of registrations) {
    registration.localTransitionSettled({ settlement });
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
