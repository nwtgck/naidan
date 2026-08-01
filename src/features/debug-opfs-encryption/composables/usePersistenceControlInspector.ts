import { readonly, ref, shallowReadonly, shallowRef } from 'vue';
import type { PersistenceControlInspectionSource } from '@/features/debug-opfs-encryption/logic/persistence-control-inspection-source';

type NativeInspectionSourceModule = Readonly<{
  createNativeOpfsPersistenceControlInspectionSource: () => PersistenceControlInspectionSource;
}>;

const isOpen = ref(false);
const inspectionSource = shallowRef<PersistenceControlInspectionSource>();
let defaultSourceLoad: Promise<void> | undefined;

/**
 * Installs the current read-only inspection source.
 *
 * The default open path lazily creates a native source that rereads exact
 * A/B bytes on every refresh. An authenticated provider may replace it with a
 * generation-scoped proof source. Exact object identity prevents stale cleanup
 * from either owner from removing the newer source.
 */
export function installPersistenceControlInspectionSource({ source }: {
  source: PersistenceControlInspectionSource;
}): () => void {
  inspectionSource.value = source;
  return () => {
    if (inspectionSource.value === source) inspectionSource.value = undefined;
  };
}

async function ensureDefaultPersistenceControlInspectionSourceWith({ loadSource }: {
  loadSource: () => Promise<NativeInspectionSourceModule>;
}): Promise<void> {
  if (inspectionSource.value !== undefined) return;
  const inFlight = defaultSourceLoad;
  if (inFlight !== undefined) {
    await inFlight;
    return;
  }

  const loading = (async () => {
    const sourceModule = await loadSource();
    if (inspectionSource.value === undefined) {
      installPersistenceControlInspectionSource({
        source: sourceModule.createNativeOpfsPersistenceControlInspectionSource(),
      });
    }
  })();
  defaultSourceLoad = loading;
  try {
    await loading;
  } finally {
    if (defaultSourceLoad === loading) defaultSourceLoad = undefined;
  }
}

async function ensureDefaultPersistenceControlInspectionSource(): Promise<void> {
  await ensureDefaultPersistenceControlInspectionSourceWith({
    loadSource: async () => await import(
      '@/features/debug-opfs-encryption/logic/native-opfs-persistence-control-inspection-source'
    ),
  });
}

export function usePersistenceControlInspector() {
  async function openPersistenceControlInspector(): Promise<void> {
    await ensureDefaultPersistenceControlInspectionSource();
    isOpen.value = true;
  }

  function closePersistenceControlInspector(): void {
    isOpen.value = false;
  }

  return {
    isPersistenceControlInspectorOpen: readonly(isOpen),
    persistenceControlInspectionSource: shallowReadonly(inspectionSource),
    openPersistenceControlInspector,
    closePersistenceControlInspector,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  ensureDefaultPersistenceControlInspectionSourceWith,
  reset() {
    defaultSourceLoad = undefined;
    inspectionSource.value = undefined;
    isOpen.value = false;
  },
};
