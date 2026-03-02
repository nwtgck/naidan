import { ref } from 'vue';

export type PrintMode = 'chat' | undefined;

const activePrintMode = ref<PrintMode>(undefined);
const printReadyResolver = ref<(() => void) | null>(null);

export function usePrint() {
  const setActivePrintMode = ({ mode }: { mode: PrintMode }) => {
    activePrintMode.value = mode;
  };

  /**
   * Called by the print-specific component when it is fully mounted and ready.
   */
  const markPrintReady = () => {
    if (printReadyResolver.value) {
      printReadyResolver.value();
      printReadyResolver.value = null;
    }
  };

  /**
   * Creates a promise that resolves when markPrintReady is called.
   */
  const waitForPrintReady = () => {
    return new Promise<void>((resolve) => {
      printReadyResolver.value = resolve;
    });
  };

  return {
    activePrintMode,
    setActivePrintMode,
    markPrintReady,
    waitForPrintReady,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
