import { describe, expect, it, vi } from 'vitest';
import { isProxy, reactive } from 'vue';
import type * as Comlink from 'comlink';
import type { IDebugEncryptedStorageWorker } from './types';
import { TEST_ONLY } from './client-hosted';

describe('hosted debug encrypted storage Worker client', () => {
  it('removes Vue proxies at the Comlink request boundary', async () => {
    const loadNode = vi.fn(async ({ ref }) => {
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
    });
    const loadPersistedJson = vi.fn(async ({ ref }) => {
      expect(isProxy(ref)).toBe(false);
      expect(() => structuredClone(ref)).not.toThrow();
      return undefined;
    });
    const remote = {
      loadNode,
      loadPersistedJson,
    } as unknown as Comlink.Remote<IDebugEncryptedStorageWorker>;
    const client = TEST_ONLY.createClient({
      remote,
      worker: { terminate: vi.fn() } as unknown as Worker,
    });
    const ref = reactive({
      type: 'logical_object' as const,
      area: 'durable' as const,
      namespace: 'singleton',
      key: 'store_manifest',
    });

    await client.loadNode({ ref });
    await client.loadPersistedJson({ ref });

    expect(loadNode).toHaveBeenCalledOnce();
    expect(loadPersistedJson).toHaveBeenCalledOnce();
  });
});
