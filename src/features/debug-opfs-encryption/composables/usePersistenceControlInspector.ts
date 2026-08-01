import { readonly, ref, shallowReadonly, shallowRef } from 'vue';
import type { PersistenceControlInspectionSource } from '@/features/debug-opfs-encryption/logic/persistence-control-inspection-source';

const isOpen = ref(false);
const inspectionSource = shallowRef<PersistenceControlInspectionSource>();

/**
 * Installs the current read-only inspection source.
 *
 * Application composition installs a lazy native source that rereads exact
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

export function usePersistenceControlInspector() {
  function openPersistenceControlInspector(): void {
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
};
