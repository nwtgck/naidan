import { ref } from 'vue';

const isOpen = ref(false);

export function useDebugEncryptedOpfsInspector() {
  function openDebugEncryptedOpfsInspector(): void {
    isOpen.value = true;
  }

  function closeDebugEncryptedOpfsInspector(): void {
    isOpen.value = false;
  }

  return {
    isDebugEncryptedOpfsInspectorOpen: isOpen,
    openDebugEncryptedOpfsInspector,
    closeDebugEncryptedOpfsInspector,
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
