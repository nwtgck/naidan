import { ref, readonly } from 'vue';

const _allowAllExternalImages = ref(false);

export function useExternalResourceSettings() {
  function setAllowAllExternalImages(allow: boolean) {
    _allowAllExternalImages.value = allow;
  }

  function __testOnlyReset() {
    _allowAllExternalImages.value = false;
  }

  return {
    allowAllExternalImages: readonly(_allowAllExternalImages),
    setAllowAllExternalImages,
    __testOnlyReset,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
