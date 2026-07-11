import type { FileExplorerWorkerClient } from './types';

const activeClients = new Set<FileExplorerWorkerClient>();

export function registerFileExplorerWorkerClient({
  client,
}: {
  client: FileExplorerWorkerClient,
}): FileExplorerWorkerClient {
  let disposePromise: Promise<void> | undefined;
  const registeredClient: FileExplorerWorkerClient = {
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
 * Stops every File Explorer worker before an OPFS encryption transition.
 *
 * Closing the modal starts component unmounting, but its worker disposal is
 * asynchronous. Registered clients remain visible until that disposal has
 * settled, so a transition waits for an already-started disposal rather than
 * racing a worker that still retains native OPFS handles.
 */
export async function disposeAllFileExplorerWorkerClientsForStorageTransition(): Promise<void> {
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
      throw new Error(`Unhandled File Explorer disposal result: ${String(_ex)}`);
    }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Failed to stop all File Explorer workers before the OPFS encryption transition',
    );
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  activeClients,
};
