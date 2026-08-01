import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpfsPersistenceRuntime } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import {
  createInstalledOpfsPersistenceRuntime,
  TEST_ONLY as REGISTRY_TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/persistence-runtime-registry';
import {
  TEST_ONLY as LOADER_TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/development-persistence-runtime-loader';

function runtime(): OpfsPersistenceRuntime {
  return {
    writableProfile: 'development-unverified',
    async changePassphrase() {
      throw new Error('not used');
    },
    async inspect() {
      return { type: 'plain' };
    },
    async runStartupMaintenance() {},
    async runTransition() {
      throw new Error('not used');
    },
    async runUnlockedMaintenance() {
      return { remainingEntryCount: 0, removedEntryCount: 0, state: 'completed' };
    },
    async unlockWithPassphrase() {
      throw new Error('not used');
    },
  };
}

afterEach(() => {
  REGISTRY_TEST_ONLY.reset();
});

describe('lazy development OPFS Persistence runtime composition', () => {
  it('loads the HizoFS runtime only on request and coalesces concurrent module loads', async () => {
    const subject = runtime();
    const createRuntime = vi.fn(() => subject);
    let resolveModule!: (module: {
      createDevelopmentUnverifiedOpfsPersistenceRuntime: typeof createRuntime;
    }) => void;
    const loadRuntime = vi.fn(() => new Promise<{
      createDevelopmentUnverifiedOpfsPersistenceRuntime: typeof createRuntime;
    }>((resolve) => {
      resolveModule = resolve;
    }));
    const lockManager = {} as LockManager;

    const uninstall = LOADER_TEST_ONLY.installLazyDevelopmentUnverifiedOpfsPersistenceRuntimeWith({
      loadRuntime,
      lockManager,
    });
    expect(loadRuntime).not.toHaveBeenCalled();

    const firstRuntime = createInstalledOpfsPersistenceRuntime();
    const secondRuntime = createInstalledOpfsPersistenceRuntime();
    expect(loadRuntime).toHaveBeenCalledOnce();

    resolveModule({ createDevelopmentUnverifiedOpfsPersistenceRuntime: createRuntime });
    await expect(firstRuntime).resolves.toBe(subject);
    await expect(secondRuntime).resolves.toBe(subject);

    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(createRuntime).toHaveBeenNthCalledWith(1, { lockManager });
    expect(createRuntime).toHaveBeenNthCalledWith(2, { lockManager });
    uninstall();
  });

  it('retries a failed module load without publishing a partial runtime', async () => {
    const subject = runtime();
    const failure = new Error('runtime chunk unavailable');
    const loadRuntime = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        createDevelopmentUnverifiedOpfsPersistenceRuntime: () => subject,
      });

    LOADER_TEST_ONLY.installLazyDevelopmentUnverifiedOpfsPersistenceRuntimeWith({
      loadRuntime,
      lockManager: {} as LockManager,
    });

    await expect(createInstalledOpfsPersistenceRuntime()).rejects.toBe(failure);
    await expect(createInstalledOpfsPersistenceRuntime()).resolves.toBe(subject);
    expect(loadRuntime).toHaveBeenCalledTimes(2);
  });
});
