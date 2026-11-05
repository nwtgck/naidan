import { onScopeDispose, watch, type Ref } from 'vue';

// One debounced intent, not a queue of obsolete text snapshots. The session
// keeps busy true until cancellation has settled, including native teardown.
export function useAutomaticTranslation({ key, enabled, ready, busy, composing, run, invalidate, stop }: {
  key: Readonly<Ref<string>>,
  enabled: Readonly<Ref<boolean>>,
  ready: Readonly<Ref<boolean>>,
  busy: Readonly<Ref<boolean>>,
  composing: Readonly<Ref<boolean>>,
  run: () => Promise<void>,
  invalidate: () => void,
  stop: () => void,
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempted: string | undefined;
  let quietUntil = 0;
  let disposed = false;

  function clearTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule(): void {
    clearTimer();
    if (disposed || !enabled.value || !ready.value || busy.value || composing.value || attempted === key.value) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || !enabled.value || !ready.value || busy.value || composing.value || attempted === key.value) {
        return;
      }
      attempted = key.value;
      // The session reports failures in its reactive state. An attempted key is
      // not retried just because the service changes from working to idle.
      void run();
    }, Math.max(0, quietUntil - Date.now()));
  }

  watch([key, composing], () => {
    clearTimer();
    attempted = undefined;
    quietUntil = Date.now() + 600;
    invalidate();
    schedule();
  }, { flush: 'sync' });
  watch(enabled, value => {
    if (value) {
      attempted = undefined;
      quietUntil = Date.now() + 600;
    }
    schedule();
  }, { flush: 'sync' });
  watch([ready, busy], schedule, { immediate: true });

  async function runManually(): Promise<void> {
    if (disposed || !ready.value || busy.value || composing.value) {
      return;
    }
    clearTimer();
    attempted = key.value;
    await run();
  }

  function stopManually(): void {
    clearTimer();
    // Explicit stop wins over the automatic scheduler until the request is
    // edited, the user retries, or automatic translation is enabled again.
    attempted = key.value;
    stop();
  }

  onScopeDispose(() => {
    disposed = true;
    clearTimer();
  });
  return { runManually, stopManually, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
