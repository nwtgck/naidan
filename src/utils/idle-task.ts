export interface ScheduledIdleTask {
  cancel(): void;
}

export function scheduleIdleTask({ task, timeoutMs, fallbackDelayMs }: {
  task: () => Promise<void>,
  timeoutMs: number,
  fallbackDelayMs: number,
}): ScheduledIdleTask {
  let cancelled = false;

  const runTask = () => {
    if (cancelled) {
      return;
    }

    (async () => {
      try {
        await task();
      } catch (error) {
        console.error('Scheduled idle task failed:', error);
      }
    })();
  };

  const requestIdleCallback = globalThis.requestIdleCallback;
  if (requestIdleCallback !== undefined) {
    const cancelIdleCallback = globalThis.cancelIdleCallback;
    const handle = requestIdleCallback(() => {
      runTask();
    }, { timeout: timeoutMs });
    return {
      cancel(): void {
        cancelled = true;
        if (cancelIdleCallback !== undefined) {
          cancelIdleCallback(handle);
        }
      },
    };
  }

  const handle = globalThis.setTimeout(runTask, fallbackDelayMs);
  return {
    cancel(): void {
      cancelled = true;
      globalThis.clearTimeout(handle);
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
