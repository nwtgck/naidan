import { readonly, ref, shallowReadonly, shallowRef } from 'vue';
import type { HizoFSPhysicalInspectionSource } from '@/features/debug-hizofs/logic/active-physical-inspection-source';

const isOpen = ref(false);
const physicalInspectionSource = shallowRef<HizoFSPhysicalInspectionSource>();

/**
 * Installs the active provider's read-only physical Inspector source.
 *
 * The source is generation-scoped and provider-owned. The cleanup uses exact
 * object identity so a late disposal from an old provider cannot remove the
 * source installed by a newer storage generation.
 */
export function installHizoFSPhysicalInspectionSource({ source }: {
  source: HizoFSPhysicalInspectionSource;
}): () => void {
  physicalInspectionSource.value = source;
  return () => {
    if (physicalInspectionSource.value === source) physicalInspectionSource.value = undefined;
  };
}

export function useDebugHizoFSWorkbench() {
  function openDebugHizoFSWorkbench(): void {
    isOpen.value = true;
  }

  function closeDebugHizoFSWorkbench(): void {
    isOpen.value = false;
  }

  return {
    isDebugHizoFSWorkbenchOpen: readonly(isOpen),
    physicalInspectionSource: shallowReadonly(physicalInspectionSource),
    openDebugHizoFSWorkbench,
    closeDebugHizoFSWorkbench,
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
