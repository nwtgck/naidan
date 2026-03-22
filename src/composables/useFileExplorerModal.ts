import { ref } from 'vue';

const isOpen = ref(false);

export function useFileExplorerModal() {
  function open(): void {
    isOpen.value = true;
  }

  function close(): void {
    isOpen.value = false;
  }

  return {
    isFileExplorerOpen: isOpen,
    openFileExplorer: open,
    closeFileExplorer: close,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
