import { ref } from 'vue';

const isOpen = ref(false);

export function useDebugEncryptedStorageInspector() {
  function openDebugEncryptedStorageInspector(): void {
    isOpen.value = true;
  }

  function closeDebugEncryptedStorageInspector(): void {
    isOpen.value = false;
  }

  return {
    isDebugEncryptedStorageInspectorOpen: isOpen,
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
