import { ref } from 'vue';

export type OverlayType = 'none' | 'search' | 'recent';

const activeOverlay = ref<OverlayType>('none');

/** @effects [] */
export function useOverlay() {
  /** @effects [] */
  const openOverlay = ({ type }: { type: OverlayType }) => {
    activeOverlay.value = type;
  };

  /** @effects [] */
  const closeOverlay = () => {
    activeOverlay.value = 'none';
  };

  /** @effects [] */
  const toggleOverlay = ({ type }: { type: OverlayType }) => {
    activeOverlay.value = activeOverlay.value === type ? 'none' : type;
  };

  return {
    activeOverlay,
    openOverlay,
    closeOverlay,
    toggleOverlay,
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
