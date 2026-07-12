import { ref } from 'vue';
import type { EncryptedStorageDebugNodeRef } from '@/features/debug-encrypted-storage/worker/types';

const isOpen = ref(false);
const initialNode = ref<EncryptedStorageDebugNodeRef>({ type: 'root' });

export function useDebugEncryptedStorageInspector() {
  function openDebugEncryptedStorageInspector({
    ref = { type: 'root' },
  }: {
    ref?: EncryptedStorageDebugNodeRef,
  } = {}): void {
    initialNode.value = ref;
    isOpen.value = true;
  }

  function closeDebugEncryptedStorageInspector(): void {
    isOpen.value = false;
  }

  return {
    isDebugEncryptedStorageInspectorOpen: isOpen,
    debugEncryptedStorageInitialNode: initialNode,
    openDebugEncryptedStorageInspector,
    closeDebugEncryptedStorageInspector,
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
