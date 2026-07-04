export interface ModuleLoader<TModule> {
  load(): Promise<TModule>;
  prefetch(): Promise<void>;
}

export function createModuleLoader<TModule>({ importModule, onPrefetchError }: {
  importModule: () => Promise<TModule>,
  onPrefetchError: ({ error }: { error: unknown }) => void,
}): ModuleLoader<TModule> {
  let modulePromise: Promise<TModule> | undefined;

  async function load(): Promise<TModule> {
    if (modulePromise !== undefined) {
      return await modulePromise;
    }

    const currentPromise = importModule();
    modulePromise = currentPromise;
    try {
      return await currentPromise;
    } catch (error) {
      if (modulePromise === currentPromise) {
        modulePromise = undefined;
      }
      throw error;
    }
  }

  async function prefetch(): Promise<void> {
    try {
      await load();
    } catch (error) {
      onPrefetchError({ error });
    }
  }

  return { load, prefetch };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
