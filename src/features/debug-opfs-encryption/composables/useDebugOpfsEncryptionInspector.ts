import { ref } from 'vue';

const isOpen = ref(false);

export function useDebugOpfsEncryptionInspector() {
  function openDebugOpfsEncryptionInspector(): void {
    isOpen.value = true;
  }

  function closeDebugOpfsEncryptionInspector(): void {
    isOpen.value = false;
  }

  return {
    isDebugOpfsEncryptionInspectorOpen: isOpen,
    openDebugOpfsEncryptionInspector,
    closeDebugOpfsEncryptionInspector,
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
