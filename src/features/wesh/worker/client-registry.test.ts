import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WeshWorkerClient } from './types';
import {
  disposeAllWeshWorkerClientsForStorageTransition,
  registerWeshWorkerClient,
  TEST_ONLY,
} from './client-registry';

function createClient({
  dispose,
}: {
  dispose: () => Promise<void>,
}): WeshWorkerClient {
  return { dispose } as unknown as WeshWorkerClient;
}

afterEach(async () => {
  const clients = [...TEST_ONLY.activeClients];
  await Promise.allSettled(clients.map(async client => await client.dispose()));
});

describe('Wesh worker client registry', () => {
  it('disposes every registered client before a storage transition', async () => {
    const firstDispose = vi.fn().mockResolvedValue(undefined);
    const secondDispose = vi.fn().mockResolvedValue(undefined);
    registerWeshWorkerClient({ client: createClient({ dispose: firstDispose }) });
    registerWeshWorkerClient({ client: createClient({ dispose: secondDispose }) });

    await disposeAllWeshWorkerClientsForStorageTransition();

    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(TEST_ONLY.activeClients.size).toBe(0);
  });

  it('waits for a disposal that was already started by another caller', async () => {
    let finishDispose: (() => void) | undefined;
    const dispose = vi.fn().mockImplementation(async () => await new Promise<void>((resolve) => {
      finishDispose = resolve;
    }));
    const client = registerWeshWorkerClient({ client: createClient({ dispose }) });

    const firstDisposal = client.dispose();
    const transitionDisposal = disposeAllWeshWorkerClientsForStorageTransition();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledOnce();
    expect(TEST_ONLY.activeClients.size).toBe(1);
    finishDispose?.();
    await Promise.all([firstDisposal, transitionDisposal]);
    expect(TEST_ONLY.activeClients.size).toBe(0);
  });

  it('reports disposal failures and removes the failed clients from the registry', async () => {
    const disposeError = new Error('dispose failed');
    registerWeshWorkerClient({
      client: createClient({ dispose: vi.fn().mockRejectedValue(disposeError) }),
    });

    await expect(disposeAllWeshWorkerClientsForStorageTransition()).rejects.toThrow(
      'Failed to stop all Wesh workers before the OPFS encryption transition',
    );
    expect(TEST_ONLY.activeClients.size).toBe(0);
  });
});
