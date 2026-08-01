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

function throwRegistrationFailures({ failures, message }: {
  failures: readonly unknown[];
  message: string;
}): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}

function runEveryRegistrationCallback({
  message,
  run,
}: {
  message: string;
  run: ({ registration }: { registration: OpfsStorageTransitionRegistration }) => void;
}): void {
  const failures: unknown[] = [];
  for (const registration of registrations) {
    try {
      run({ registration });
    } catch (cause: unknown) {
      failures.push(cause);
    }
  }
  throwRegistrationFailures({ failures, message });
}

async function runEveryRegistrationCallbackAsync({
  message,
  run,
}: {
  message: string;
  run: ({ registration }: { registration: OpfsStorageTransitionRegistration }) => Promise<void>;
}): Promise<void> {
  const results = await Promise.allSettled(
    [...registrations].map(async registration => await run({ registration })),
  );
  const failures = results.flatMap(result => {
    switch (result.status) {
    case 'fulfilled': return [];
    case 'rejected': return [result.reason];
    default: return result satisfies never;
    }
  });
  throwRegistrationFailures({ failures, message });
}

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
  runEveryRegistrationCallback({
    message: 'Multiple local OPFS transition start callbacks failed',
    run: ({ registration }) => registration.localTransitionStarting(),
  });
}

export async function notifyRegisteredOpfsExternalTransitionStarting(): Promise<void> {
  await runEveryRegistrationCallbackAsync({
    message: 'Multiple external OPFS transition start callbacks failed',
    run: async ({ registration }) => await registration.externalTransitionStarting(),
  });
}

export async function prepareRegisteredOpfsStorageTransition(): Promise<void> {
  await runEveryRegistrationCallbackAsync({
    message: 'Multiple OPFS transition safety preparations failed',
    run: async ({ registration }) => await registration.prepare(),
  });
}

export function notifyRegisteredOpfsLocalTransitionSettled({
  settlement,
}: {
  settlement: OpfsExternalTransitionSettlement,
}): void {
  runEveryRegistrationCallback({
    message: 'Multiple local OPFS transition settlement callbacks failed',
    run: ({ registration }) => registration.localTransitionSettled({ settlement }),
  });
}

export function notifyRegisteredOpfsExternalTransitionSettled({
  settlement,
}: {
  settlement: OpfsExternalTransitionSettlement,
}): void {
  runEveryRegistrationCallback({
    message: 'Multiple external OPFS transition settlement callbacks failed',
    run: ({ registration }) => registration.externalTransitionSettled({ settlement }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  registrations,
  throwRegistrationFailures,
};
