import type { DebugEncryptedStorageWorkerClient } from './types';

const activeClients = new Set<DebugEncryptedStorageWorkerClient>();

export function trackDebugEncryptedStorageWorkerClient({
  client,
}: {
  client: DebugEncryptedStorageWorkerClient,
}): DebugEncryptedStorageWorkerClient {
  let disposePromise: Promise<void> | undefined;
  const tracked: DebugEncryptedStorageWorkerClient = {
    async loadNode({ ref }) {
      return await client.loadNode({ ref });
    },
    async search({ query }) {
      return await client.search({ query });
    },
    async scanIntegrity() {
      return await client.scanIntegrity();
    },
    dispose() {
      disposePromise ??= (async () => {
        try {
          await client.dispose();
        } finally {
          activeClients.delete(tracked);
        }
      })();
      return disposePromise;
    },
  };
  activeClients.add(tracked);
  return tracked;
}

/**
 * Stops every Inspector worker before an OPFS encryption transition.
 *
 * Closing the modal starts unmount disposal asynchronously. Clients remain in
 * this registry until that disposal settles so the transition cannot release
 * its shared OPFS session lock while a Worker still owns a cloned debug
 * capability and native OPFS handles.
 */
export async function disposeAllDebugEncryptedStorageWorkerClientsForStorageTransition(): Promise<void> {
  const clients = [...activeClients];
  const results = await Promise.allSettled(clients.map(async client => await client.dispose()));
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Failed to dispose Encrypted Storage Inspector workers before the OPFS transition',
    );
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  activeClients,
};
