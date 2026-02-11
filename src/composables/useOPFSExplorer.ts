import { ref } from 'vue';

const isOPFSOpen = ref(false);

export function useOPFSExplorer() {
  function openOPFS() {
    isOPFSOpen.value = true;
  }

  function closeOPFS() {
    isOPFSOpen.value = false;
  }

  function toggleOPFS() {
    isOPFSOpen.value = !isOPFSOpen.value;
  }

  return {
    isOPFSOpen,
    openOPFS,
    closeOPFS,
    toggleOPFS,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
