import { ref } from 'vue';

export type PrintMode = 'chat' | undefined;

const activePrintMode = ref<PrintMode>(undefined);
const printReadyResolver = ref<(() => void) | null>(null);

/**
 * Internal setter for the current print mode.
 */
function setActivePrintMode({ mode }: { mode: PrintMode }) {
  activePrintMode.value = mode;
}

/**
 * Internal promise-based wait mechanism for component readiness.
 */
function waitForPrintReady() {
  return new Promise<void>((resolve) => {
    printReadyResolver.value = resolve;
  });
}

/**
 * usePrint manages the state and orchestration for high-fidelity printing.
 * It provides a clean API to trigger printing while hiding internal synchronization details.
 */
export function usePrint() {
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
   * Triggers the high-fidelity printing flow.
   * It handles title swapping, rendering synchronization, and cleanup.
   */
  const print = async ({ title, mode }: { title: string | undefined, mode: Exclude<PrintMode, undefined> }) => {
    const oldTitle = document.title;

    try {
      const readyPromise = waitForPrintReady();
      setActivePrintMode({ mode });

      if (title) {
        document.title = title;
      }

      await readyPromise;
      window.print();
    } finally {
      setActivePrintMode({ mode: undefined });
      document.title = oldTitle;
    }
  };

  return {
    activePrintMode,
    print,
    markPrintReady,
    __testOnly: {
      setActivePrintMode,
      waitForPrintReady,
    }
  };
}
