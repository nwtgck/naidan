import { onScopeDispose, ref, watch, type Ref } from 'vue';

// One debounced intent, not a queue of obsolete text snapshots. The session
// keeps busy true until cancellation has settled, including native teardown.
export function useAutomaticTranslation({ key, enabled, ready, busy, composing, debounceMs, run, invalidate, stop }: {
  key: Readonly<Ref<string>>,
  enabled: Readonly<Ref<boolean>>,
  ready: Readonly<Ref<boolean>>,
  busy: Readonly<Ref<boolean>>,
  composing: Readonly<Ref<boolean>>,
  debounceMs: Readonly<Ref<number>>,
  run: () => Promise<void>,
  invalidate: () => void,
  stop: () => void,
}) {
  const manuallyStopped = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempted: string | undefined;
  let lastChangeAt = Date.now();
  let quietUntil = lastChangeAt + debounceMs.value;
  let disposed = false;

  function clearTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule(): void {
    clearTimer();
    if (disposed || !enabled.value || !ready.value || busy.value || attempted === key.value) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || !enabled.value || !ready.value || busy.value || attempted === key.value) {
        return;
      }
      attempted = key.value;
      // The session reports failures in its reactive state. An attempted key is
      // not retried just because the service changes from working to idle.
      void run();
    }, Math.max(0, quietUntil - Date.now()));
  }

  watch(key, () => {
    clearTimer();
    attempted = undefined;
    manuallyStopped.value = false;
    lastChangeAt = Date.now();
    quietUntil = lastChangeAt + debounceMs.value;
    invalidate();
    schedule();
  }, { flush: 'sync' });
  watch(debounceMs, () => {
    // Changing timing neither cancels a running request nor retries a stopped one.
    quietUntil = lastChangeAt + debounceMs.value;
    schedule();
  }, { flush: 'sync' });
  watch(enabled, value => {
    if (value) {
      attempted = undefined;
      manuallyStopped.value = false;
      lastChangeAt = Date.now();
      quietUntil = lastChangeAt + debounceMs.value;
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
    manuallyStopped.value = false;
    await run();
  }

  function stopManually(): void {
    clearTimer();
    // Explicit stop wins over the automatic scheduler until the request is
    // edited, the user retries, or automatic translation is enabled again.
    attempted = key.value;
    manuallyStopped.value = true;
    stop();
  }

  onScopeDispose(() => {
    disposed = true;
    clearTimer();
  });
  return { runManually, stopManually, manuallyStopped, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
