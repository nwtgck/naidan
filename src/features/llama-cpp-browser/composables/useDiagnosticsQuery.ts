import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import { isNavigationFailure, NavigationFailureType, useRoute, useRouter } from 'vue-router';
import { isDiagnosticsEditValid, parseDiagnosticsQuery, serializeDiagnosticsQuery, type DiagnosticsQueryConfig } from '@/features/llama-cpp-browser/diagnostics/query-parameters';

/** Page-only adapter. No watches of form values: only edit() writes a URL. */
export function useDiagnosticsQuery({ load }: { load: ({ config }: { config: DiagnosticsQueryConfig }) => void }) {
  const route = useRoute(), router = useRouter();
  const path = route.path;
  const config = shallowRef(parseDiagnosticsQuery({ query: route.query }));
  const syncing = ref(false), error = ref(''), revision = ref(0);
  let alive = true, dirty = false, navigationEpoch = 0;
  let ownTarget: string | undefined;
  let task: Promise<boolean> | undefined;
  load({ config: config.value });

  // A new navigation supersedes a queued edit even before route.current changes.
  const removeGuard = router.beforeEach(to => {
    if (to.fullPath !== ownTarget) {
      navigationEpoch++;
      dirty = false;
    }
  });
  watch(() => route.fullPath, fullPath => {
    if (fullPath === ownTarget) {
      return;
    }
    revision.value++;
    error.value = '';
    if (route.path === path) {
      const next = parseDiagnosticsQuery({ query: route.query });
      // Unknown keys have no effect, even during a run. Only a different known
      // configuration is an external request to replace the form / stop the run.
      if (key({ value: next }) !== key({ value: config.value })) {
        config.value = next;
        load({ config: next });
      }
    }
  }, { flush: 'sync' });

  function key({ value }: { value: DiagnosticsQueryConfig }): string {
    return JSON.stringify(serializeDiagnosticsQuery({ config: value }));
  }

  function committed(): boolean {
    if (!alive || route.path !== path) {
      return false;
    }
    if (key({ value: config.value }) !== key({ value: parseDiagnosticsQuery({ query: route.query }) })) {
      error.value ||= 'The URL update was interrupted. Retry before starting diagnostics.';
      return false;
    }
    return !error.value;
  }

  function flush(): Promise<boolean> {
    if (task) {
      return task;
    }
    if (!alive || route.path !== path || error.value) {
      return Promise.resolve(false);
    }
    syncing.value = dirty;
    task = Promise.resolve().then(async () => {
      while (dirty && alive && route.path === path) {
        dirty = false;
        const epoch = navigationEpoch;
        try {
          const target = { path, query: serializeDiagnosticsQuery({ config: config.value }) };
          ownTarget = router.resolve(target).fullPath;
          if (ownTarget === route.fullPath) {
            continue;
          }
          const failure = await router.replace(target);
          if (!alive || epoch !== navigationEpoch) {
            // The competing navigation may itself have been rejected. If we
            // remain here, never enable Start with a stale URL and new form.
            committed();
            return false;
          }
          if (failure) {
            const message = failure.message;
            if (!isNavigationFailure(failure, NavigationFailureType.duplicated)) {
              throw new Error(message);
            }
          }
        } catch (cause) {
          if (alive && epoch === navigationEpoch) {
            error.value = cause instanceof Error ? cause.message : String(cause);
          }
          return false;
        } finally {
          ownTarget = undefined;
        }
      }
      return committed();
    }).finally(() => {
      task = undefined;
      syncing.value = false;
      // An edit can be queued in the microtask between finishing the loop and
      // this finalizer. Do not leave that newest edit stranded.
      if (dirty && alive && !error.value && route.path === path) {
        void flush();
      }
    });
    return task;
  }

  function edit({ patch }: { patch: DiagnosticsQueryConfig }): boolean {
    if (!alive || route.path !== path || !isDiagnosticsEditValid({ patch })) {
      return false;
    }
    config.value = { ...config.value, ...patch };
    revision.value++;
    error.value = '';
    dirty = true;
    void flush();
    return true;
  }
  function reset(): void {
    if (!alive || route.path !== path) {
      return;
    }
    config.value = {};
    revision.value++;
    error.value = '';
    dirty = true;
    load({ config: config.value });
    void flush();
  }
  function retry(): void {
    if (!alive || route.path !== path) {
      return;
    }
    error.value = '';
    dirty = true;
    void flush();
  }
  onScopeDispose(() => {
    alive = false;
    dirty = false;
    navigationEpoch++;
    removeGuard();
  });
  return { config, syncing, error, revision, edit, flush, reset, retry, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
