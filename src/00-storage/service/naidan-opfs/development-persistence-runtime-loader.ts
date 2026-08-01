import type { OpfsPersistenceRuntime } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import { installOpfsPersistenceRuntimeFactory } from '@/00-storage/service/naidan-opfs/persistence-runtime-registry';

type DevelopmentRuntimeModule = Readonly<{
  createDevelopmentUnverifiedOpfsPersistenceRuntime: ({ lockManager }: {
    lockManager: LockManager;
  }) => OpfsPersistenceRuntime;
}>;

function installLazyDevelopmentUnverifiedOpfsPersistenceRuntimeWith({ loadRuntime, lockManager }: {
  loadRuntime: () => Promise<DevelopmentRuntimeModule>;
  lockManager: LockManager;
}): () => void {
  let runtimeModuleLoad: Promise<DevelopmentRuntimeModule> | undefined;

  async function requireRuntimeModule(): Promise<DevelopmentRuntimeModule> {
    const inFlight = runtimeModuleLoad;
    if (inFlight !== undefined) return await inFlight;

    const loading = loadRuntime();
    runtimeModuleLoad = loading;
    try {
      return await loading;
    } catch (error: unknown) {
      if (runtimeModuleLoad === loading) runtimeModuleLoad = undefined;
      throw error;
    }
  }

  return installOpfsPersistenceRuntimeFactory({
    factory: async () => {
      const runtimeModule = await requireRuntimeModule();
      return runtimeModule.createDevelopmentUnverifiedOpfsPersistenceRuntime({ lockManager });
    },
  });
}

/**
 * Installs only a small factory into the startup graph.
 *
 * WHY: Plain OPFS checks for Persistence Control before requesting this
 * factory. Keeping the production HizoFS runtime behind this dynamic import
 * preserves fail-closed authority selection without charging plain users for
 * transition, crypto, maintenance, and Worker composition at entry evaluation.
 */
export function installLazyDevelopmentUnverifiedOpfsPersistenceRuntime(): () => void {
  return installLazyDevelopmentUnverifiedOpfsPersistenceRuntimeWith({
    loadRuntime: async () => await import(
      '@/00-storage/service/naidan-opfs/development-persistence-runtime'
    ),
    lockManager: navigator.locks,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  installLazyDevelopmentUnverifiedOpfsPersistenceRuntimeWith,
};
