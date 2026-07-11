import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileExplorerWorkerClient } from './types';
import {
  disposeAllFileExplorerWorkerClientsForStorageTransition,
  registerFileExplorerWorkerClient,
  TEST_ONLY,
} from './client-registry';

function createClient({
  dispose,
}: {
  dispose: () => Promise<void>,
}): FileExplorerWorkerClient {
  return { dispose } as unknown as FileExplorerWorkerClient;
}

afterEach(async () => {
  const clients = [...TEST_ONLY.activeClients];
  await Promise.allSettled(clients.map(async client => await client.dispose()));
});

describe('File Explorer worker client registry', () => {
  it('disposes every registered client before a storage transition', async () => {
    const firstDispose = vi.fn().mockResolvedValue(undefined);
    const secondDispose = vi.fn().mockResolvedValue(undefined);
    registerFileExplorerWorkerClient({ client: createClient({ dispose: firstDispose }) });
    registerFileExplorerWorkerClient({ client: createClient({ dispose: secondDispose }) });

    await disposeAllFileExplorerWorkerClientsForStorageTransition();

    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(TEST_ONLY.activeClients.size).toBe(0);
  });

  it('waits for disposal that already started during component unmounting', async () => {
    let finishDispose: (() => void) | undefined;
    const dispose = vi.fn().mockImplementation(async () => await new Promise<void>((resolve) => {
      finishDispose = resolve;
    }));
    const client = registerFileExplorerWorkerClient({ client: createClient({ dispose }) });

    const componentDisposal = client.dispose();
    const transitionDisposal = disposeAllFileExplorerWorkerClientsForStorageTransition();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledOnce();
    expect(TEST_ONLY.activeClients.size).toBe(1);
    finishDispose?.();
    await Promise.all([componentDisposal, transitionDisposal]);
    expect(TEST_ONLY.activeClients.size).toBe(0);
  });

  it('reports disposal failures after removing failed clients from the registry', async () => {
    const disposeError = new Error('dispose failed');
    registerFileExplorerWorkerClient({
      client: createClient({ dispose: vi.fn().mockRejectedValue(disposeError) }),
    });

    await expect(
      disposeAllFileExplorerWorkerClientsForStorageTransition(),
    ).rejects.toThrow(
      'Failed to stop all File Explorer workers before the OPFS encryption transition',
    );
    expect(TEST_ONLY.activeClients.size).toBe(0);
  });
});
