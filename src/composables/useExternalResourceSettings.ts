import { ref, readonly } from 'vue';

const _allowAllExternalImages = ref(false);

export function useExternalResourceSettings() {
  function setAllowAllExternalImages({ allow }: { allow: boolean }) {
    _allowAllExternalImages.value = allow;
  }

  function __testOnlyReset() {
    _allowAllExternalImages.value = false;
  }

  return {
    allowAllExternalImages: readonly(_allowAllExternalImages),
    setAllowAllExternalImages,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        __testOnlyReset,
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
