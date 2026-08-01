import type {
  OpfsPersistenceRuntime,
  OpfsPersistenceRuntimeFactory,
} from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';

let installedFactory: OpfsPersistenceRuntimeFactory | undefined;

export function installOpfsPersistenceRuntimeFactory({ factory }: {
  factory: OpfsPersistenceRuntimeFactory;
}): () => void {
  installedFactory = factory;
  return () => {
    if (installedFactory === factory) installedFactory = undefined;
  };
}

export async function createInstalledOpfsPersistenceRuntime(): Promise<OpfsPersistenceRuntime> {
  const factory = installedFactory;
  if (factory === undefined) {
    throw new Error('OPFS Persistence Control runtime is not connected');
  }
  return await factory();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  reset() {
    installedFactory = undefined;
  },
};
