import { usePrint, type PrintMode } from '../composables/usePrint';

/**
 * Triggers the browser's print dialog.
 * Instead of relying on non-deterministic nextTick, it waits for the
 * asynchronously loaded PrintView component to explicitly signal its readiness.
 * Uses try...finally to ensure the UI is restored even if an error occurs.
 */
export async function printElement({ title, mode }: { title: string | undefined, mode: Exclude<PrintMode, undefined> }) {
  const { setActivePrintMode, waitForPrintReady } = usePrint();
  const oldTitle = document.title;

  try {
    // 1. Prepare the listener before triggering the render
    const readyPromise = waitForPrintReady();

    // 2. Enter print mode (starts async loading of PrintView/Content)
    setActivePrintMode({ mode });
    if (title) {
      document.title = title;
    }

    // 3. Await the specific signal that components are fully mounted and parsed
    await readyPromise;

    // 4. Open the browser print dialog (this is blocking in most browsers)
    window.print();
  } finally {
    // 5. Cleanup: Always restore the UI state and document title,
    // regardless of whether the print succeeded or an error occurred.
    setActivePrintMode({ mode: undefined });
    document.title = oldTitle;
  }
}
