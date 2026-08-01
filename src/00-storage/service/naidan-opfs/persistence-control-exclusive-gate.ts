const PERSISTENCE_CONTROL_AUTHORITY_LOCK_NAME = 'naidan:persistence-control:authority';

export interface NaidanPersistenceControlExclusiveGate {
  runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T>;
}

export function createBrowserNaidanPersistenceControlExclusiveGate({ lockManager }: {
  lockManager: Pick<LockManager, 'request'>;
}): NaidanPersistenceControlExclusiveGate {
  return {
    async runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
      return await lockManager.request(
        PERSISTENCE_CONTROL_AUTHORITY_LOCK_NAME,
        { mode: 'exclusive' },
        async lock => {
          if (lock === null) throw new Error('Persistence Control authority lock was not acquired');
          return await operation();
        },
      );
    },
  };
}

// Export internal state used only for testing here. Do not reference this in production logic.
export const TEST_ONLY = {
  persistenceControlAuthorityLockName: PERSISTENCE_CONTROL_AUTHORITY_LOCK_NAME,
};
