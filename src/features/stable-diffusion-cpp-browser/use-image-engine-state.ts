import { computed, ref, shallowRef, type Ref } from 'vue';
import type { ImageEngineStateView } from './use-image-generation-types';
import type { ImageClient } from './worker/types';
import type { Progress } from './types';
import type { ImageEngineSnapshot } from './engine-state';

/** A visible, on-demand observer of the already existing generation owner.
 * It never creates a client, loads models or installs polling/timers. */
export function useImageEngineState({ client, supported, progress, modelResident }: {
  client: () => ImageClient | undefined, supported: Ref<boolean>, progress: Ref<Progress | undefined>, modelResident: Ref<boolean>,
}) {
  const opened = ref(false), status = ref<ImageEngineStateView['status']['value']>('idle');
  const snapshot = shallowRef<ImageEngineSnapshot>(), reason = ref<ImageEngineStateView['reason']['value']>();
  const error = ref('');
  let revision = 0, disposed = false;
  const canRefresh = computed(() => opened.value && supported.value && modelResident.value && !progress.value && status.value !== 'refreshing' && !disposed);
  async function refresh(): Promise<void> {
    if (disposed || !opened.value || status.value === 'refreshing') return;
    if (!supported.value) {
      status.value = 'unavailable'; reason.value = 'unsupported'; return;
    }
    if (progress.value) {
      status.value = 'unavailable'; reason.value = 'busy'; return;
    }
    const owner = client();
    if (!owner || !modelResident.value) {
      status.value = 'unavailable'; reason.value = 'not-loaded'; return;
    }
    const operation = ++revision;
    status.value = 'refreshing'; error.value = ''; reason.value = undefined;
    try {
      const result = await owner.inspectEngine();
      if (disposed || !opened.value || operation !== revision || owner !== client()) return;
      switch (result.status) {
      case 'ready': snapshot.value = result.snapshot; status.value = 'idle'; break;
      case 'unavailable': status.value = 'unavailable'; reason.value = result.reason; break;
      case 'failed': status.value = 'failed'; error.value = result.message; break;
      default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
      }
    } catch (cause) {
      if (disposed || !opened.value || operation !== revision || owner !== client()) return;
      status.value = 'failed'; error.value = (cause instanceof Error ? cause.message : String(cause)).slice(0, 1024);
    }
  }
  function setOpened({ opened: value }: { opened: boolean }): void {
    if (disposed || opened.value === value) return;
    opened.value = value; ++revision; status.value = 'idle'; error.value = ''; reason.value = undefined;
    if (value) void refresh();
  }
  function invalidate(): void {
    ++revision; snapshot.value = undefined; error.value = '';
    reason.value = 'released'; status.value = opened.value ? 'unavailable' : 'idle';
  }
  function afterRun(): void {
    if (opened.value) void refresh();
  }
  function dispose(): void {
    disposed = true; opened.value = false; invalidate();
  }
  const view: ImageEngineStateView = { opened, status, snapshot, reason, error, canRefresh, setOpened, refresh };
  return { ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}), view, invalidate, afterRun, dispose };
}

export const TEST_ONLY = {
};
