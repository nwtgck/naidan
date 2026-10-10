import { ref } from 'vue';

const isLineWrapEnabled = ref(false);

/** @effects `none` */
export function useCodeBlockSettings() {
  /** @effects `none` */
  function toggleLineWrap() {
    isLineWrapEnabled.value = !isLineWrapEnabled.value;
  }

  return {
    isLineWrapEnabled,
    toggleLineWrap,
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
