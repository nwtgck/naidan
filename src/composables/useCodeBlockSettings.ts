import { ref } from 'vue';

const isLineWrapEnabled = ref(false);

export function useCodeBlockSettings() {
  function toggleLineWrap() {
    isLineWrapEnabled.value = !isLineWrapEnabled.value;
  }

  return {
    isLineWrapEnabled,
    toggleLineWrap,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
