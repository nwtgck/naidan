import { ref } from 'vue';
import { useDocumentMetadata } from '@/composables/useDocumentMetadata';

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
  const documentMetadata = useDocumentMetadata();
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
    try {
      const readyPromise = waitForPrintReady();
      setActivePrintMode({ mode });

      const run = async () => {
        await readyPromise;
        window.print();
      };
      if (documentMetadata === undefined) {
        await run();
      } else {
        await documentMetadata.withPrintTitle({ title, run });
      }
    } finally {
      setActivePrintMode({ mode: undefined });
    }
  };

  return {
    activePrintMode,
    print,
    markPrintReady,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        setActivePrintMode,
        waitForPrintReady,
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
