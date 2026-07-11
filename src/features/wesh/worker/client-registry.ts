import type { WeshWorkerClient } from './types';

const activeClients = new Set<WeshWorkerClient>();

export function registerWeshWorkerClient({
  client,
}: {
  client: WeshWorkerClient,
}): WeshWorkerClient {
  let disposePromise: Promise<void> | undefined;
  const registeredClient: WeshWorkerClient = {
    ...client,
    dispose() {
      disposePromise ??= (async () => {
        try {
          await client.dispose();
        } finally {
          activeClients.delete(registeredClient);
        }
      })();
      return disposePromise;
    },
  };
  activeClients.add(registeredClient);
  return registeredClient;
}

/**
 * Stops every Wesh worker before an OPFS encryption transition starts.
 *
 * Wesh workers may retain native OPFS directory handles after their initial
 * mount request. Merely suspending StorageService cannot revoke those handles,
 * so every active client must be disposed before the physical storage layout
 * is copied or removed.
 */
export async function disposeAllWeshWorkerClientsForStorageTransition(): Promise<void> {
  const results = await Promise.allSettled(
    [...activeClients].map(async client => await client.dispose()),
  );
  const failures: unknown[] = [];
  for (const result of results) {
    switch (result.status) {
    case 'fulfilled':
      break;
    case 'rejected':
      failures.push(result.reason);
      break;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled Wesh disposal result: ${String(_ex)}`);
    }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Failed to stop all Wesh workers before the OPFS encryption transition',
    );
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  activeClients,
};
