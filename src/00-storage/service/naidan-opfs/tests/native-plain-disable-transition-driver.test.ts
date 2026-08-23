import { describe, expect, it, vi } from 'vitest';
import { parseTransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import { createNativePlainDisableTransitionDriver } from '@/00-storage/service/naidan-opfs/native-plain-disable-transition-driver';
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from '@/00-storage/service/opfs/naidan-opfs-root-directory-registry';
import { TEST_ONLY as RUNTIME_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import type { NativePlainTransitionRuntime } from '@/00-storage/service/naidan-opfs/native-plain-transition-runtime-state';

const FILE_SYSTEM_ID = RUNTIME_TEST_ONLY.createEncryptedInspection({
  fileSystemId: '0123456789_ABCDEFGHIJ',
}).mode.activeFileSystemId;
const BINDING = {
  operationId: parseTransitionOperationId({ value: 'native_disable_test01' }),
  source: { fileSystemId: FILE_SYSTEM_ID, type: 'hizofs' },
  target: { type: 'plain' },
} as const;

function fixture({ lifecycle, names = [] }: {
  lifecycle: 'active' | 'preparing' | 'published' | 'sealed' | undefined;
  names?: readonly string[];
}) {
  const prepareTarget = vi.fn(async () => 'preparing' as const);
  const currentLifecycle = vi.fn(async () => lifecycle);
  const runtime = { currentLifecycle, prepareTarget } as unknown as NativePlainTransitionRuntime;
  const storage = {
    entries: async function* () {
      for (const name of names) {
        yield [name, { kind: 'file', name } as FileSystemFileHandle] as const;
      }
    },
  } as unknown as FileSystemDirectoryHandle;
  const root = {
    getDirectoryHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      expect(options).toEqual({ create: false });
      if (name === NAIDAN_OPFS_STORAGE_DIRECTORY_NAME) return storage;
      const error = new Error(`missing native OPFS root: ${name}`);
      error.name = 'NotFoundError';
      throw error;
    }),
  } as unknown as FileSystemDirectoryHandle;
  return {
    currentLifecycle,
    driver: createNativePlainDisableTransitionDriver({
      binding: BINDING,
      nativeNamespaceRoot: root,
      runtime,
      verificationPageSize: 16,
    }),
    prepareTarget,
    root,
  };
}

describe('native plain disable transition driver', () => {
  it('creates the runtime ownership marker only for an empty application namespace', async () => {
    const empty = fixture({ lifecycle: undefined });
    await empty.driver.prepareTarget({ binding: BINDING });
    expect(empty.prepareTarget).toHaveBeenCalledOnce();

    const occupied = fixture({ lifecycle: undefined, names: ['chat.json'] });
    await expect(occupied.driver.prepareTarget({ binding: BINDING })).rejects.toThrow('unowned application bytes');
    expect(occupied.prepareTarget).not.toHaveBeenCalled();
  });

  it('reuses staged runtime lifecycle across bounded slices without clearing application bytes', async () => {
    for (const lifecycle of ['preparing', 'active', 'sealed'] as const) {
      const { driver, prepareTarget, root } = fixture({ lifecycle, names: ['partial.bin'] });
      await driver.prepareTarget({ binding: BINDING });
      expect(prepareTarget).not.toHaveBeenCalled();
      expect(root.getDirectoryHandle).not.toHaveBeenCalled();
    }
  });

  it('projects lifecycle into readiness and requires sealed finalization', async () => {
    await expect(fixture({ lifecycle: undefined }).driver.inspectEndpoint({ endpoint: { type: 'plain' } })).resolves.toBe('absent');
    await expect(fixture({ lifecycle: 'active' }).driver.inspectEndpoint({ endpoint: { type: 'plain' } })).resolves.toBe('absent');
    await expect(fixture({ lifecycle: 'sealed' }).driver.inspectEndpoint({ endpoint: { type: 'plain' } })).resolves.toBe('fully_verified');
    await expect(fixture({ lifecycle: 'sealed' }).driver.finalizeTarget({ binding: BINDING })).resolves.toBeUndefined();
    await expect(fixture({ lifecycle: 'active' }).driver.finalizeTarget({ binding: BINDING })).rejects.toThrow('must be sealed');
  });
});
