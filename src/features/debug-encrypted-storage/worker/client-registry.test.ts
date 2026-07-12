import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  disposeAllDebugEncryptedStorageWorkerClientsForStorageTransition,
  TEST_ONLY,
  trackDebugEncryptedStorageWorkerClient,
} from './client-registry';
import type { DebugEncryptedStorageWorkerClient } from './types';

function createClient(): DebugEncryptedStorageWorkerClient {
  return {
    loadNode: vi.fn(),
    search: vi.fn(),
    scanIntegrity: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
}

afterEach(async () => {
  const clients = [...TEST_ONLY.activeClients];
  await Promise.allSettled(clients.map(async client => await client.dispose()));
});

describe('debug encrypted storage worker client registry', () => {
  it('terminates every tracked inspector client before a storage transition', async () => {
    const first = createClient();
    const second = createClient();
    trackDebugEncryptedStorageWorkerClient({ client: first });
    trackDebugEncryptedStorageWorkerClient({ client: second });

    await disposeAllDebugEncryptedStorageWorkerClientsForStorageTransition();

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(TEST_ONLY.activeClients.size).toBe(0);
  });

  it('waits for disposal that already started during component unmounting', async () => {
    let finishDispose: (() => void) | undefined;
    const inner = createClient();
    vi.mocked(inner.dispose).mockImplementation(async () => await new Promise<void>((resolve) => {
      finishDispose = resolve;
    }));
    const tracked = trackDebugEncryptedStorageWorkerClient({ client: inner });

    const componentDisposal = tracked.dispose();
    const transitionDisposal = disposeAllDebugEncryptedStorageWorkerClientsForStorageTransition();
    await Promise.resolve();

    expect(inner.dispose).toHaveBeenCalledOnce();
    expect(TEST_ONLY.activeClients.size).toBe(1);
    finishDispose?.();
    await Promise.all([componentDisposal, transitionDisposal]);
    expect(TEST_ONLY.activeClients.size).toBe(0);
  });

  it('makes tracked disposal idempotent after completion', async () => {
    const inner = createClient();
    const tracked = trackDebugEncryptedStorageWorkerClient({ client: inner });

    await tracked.dispose();
    await disposeAllDebugEncryptedStorageWorkerClientsForStorageTransition();
    await tracked.dispose();

    expect(inner.dispose).toHaveBeenCalledOnce();
  });
});
