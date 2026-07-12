import * as Comlink from 'comlink';
import { describe, expect, it, vi } from 'vitest';
import { isProxy, reactive } from 'vue';
import type { IWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub.types';
import type { IDebugEncryptedStorageWorker } from './types';
import { TEST_ONLY } from './client-standalone';

function createResources() {
  const remote = {
    loadNode: vi.fn(async ({ ref }) => {
      expect(isProxy(ref)).toBe(false);
      expect(() => structuredClone(ref)).not.toThrow();
      return {
        ref,
        kind: 'test',
        title: 'test',
        fields: [],
        value: null,
        references: [],
        warnings: [],
      };
    }),
    search: vi.fn(async () => []),
    scanIntegrity: vi.fn(async () => ({
      scannedPhysicalObjects: 0,
      knownLogicalObjects: 0,
      findings: [],
    })),
    dispose: vi.fn(async () => undefined),
    [Comlink.releaseProxy]: vi.fn(async () => undefined),
  } as unknown as Comlink.Remote<IDebugEncryptedStorageWorker>;
  const hub = {
    [Comlink.releaseProxy]: vi.fn(async () => undefined),
  } as unknown as Comlink.Remote<IWorkerHub>;
  const worker = {
    terminate: vi.fn(),
  } as unknown as Worker;
  return { remote, hub, worker };
}

describe('standalone debug encrypted storage Worker client', () => {
  it('removes Vue proxies at the shared Worker Hub request boundary', async () => {
    const { remote, hub, worker } = createResources();
    const client = TEST_ONLY.createClient({ remote, hub, worker });
    const ref = reactive({
      type: 'logical_object' as const,
      area: 'durable' as const,
      namespace: 'singleton',
      key: 'store_manifest',
    });

    await client.loadNode({ ref });

    expect(remote.loadNode).toHaveBeenCalledOnce();
  });

  it('releases the service proxy and hub proxy before terminating the Worker', async () => {
    const { remote, hub, worker } = createResources();
    const client = TEST_ONLY.createClient({ remote, hub, worker });

    await client.dispose();

    expect(remote.dispose).toHaveBeenCalledOnce();
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(hub[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates the Worker and preserves the first disposal error', async () => {
    const { remote, hub, worker } = createResources();
    const disposalError = new Error('dispose failed');
    vi.mocked(remote.dispose).mockRejectedValueOnce(disposalError);
    vi.mocked(remote[Comlink.releaseProxy]).mockRejectedValueOnce(new Error('remote release failed'));

    await expect(TEST_ONLY.disposeStandaloneResources({
      remote,
      hub,
      worker,
      disposeRemote: true,
    })).rejects.toBe(disposalError);

    expect(hub[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
