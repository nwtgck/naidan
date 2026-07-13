import { readonly, ref } from 'vue';

const isOpen = ref(false);

export function useDebugEncryptedOpfsWorkbench() {
  function openDebugEncryptedOpfsWorkbench(): void {
    isOpen.value = true;
  }

  function closeDebugEncryptedOpfsWorkbench(): void {
    isOpen.value = false;
  }

  return {
    isDebugEncryptedOpfsWorkbenchOpen: readonly(isOpen),
    openDebugEncryptedOpfsWorkbench,
    closeDebugEncryptedOpfsWorkbench,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
