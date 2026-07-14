import { readonly, ref } from 'vue';

const isOpen = ref(false);

export function useDebugHizoFSWorkbench() {
  function openDebugHizoFSWorkbench(): void {
    isOpen.value = true;
  }

  function closeDebugHizoFSWorkbench(): void {
    isOpen.value = false;
  }

  return {
    isDebugHizoFSWorkbenchOpen: readonly(isOpen),
    openDebugHizoFSWorkbench,
    closeDebugHizoFSWorkbench,
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
