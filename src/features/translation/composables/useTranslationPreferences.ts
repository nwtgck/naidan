import { computed, onScopeDispose, ref } from 'vue';
import type { useSettings } from '@/composables/useSettings';
import type { Settings } from '@/01-models/types';

type TranslationPreferences = NonNullable<NonNullable<Settings['experimental']>['translation']>;

export function useTranslationPreferences({ store }: {
  store: Pick<ReturnType<typeof useSettings>, 'settings' | 'captureExperimentalStorage' | 'updateExperimentalForStorage'>,
}) {
  const preferences = computed(() => store.settings.value.experimental?.translation);
  const saving = ref(false);
  const failed = ref(false);
  let pending: Promise<void> | undefined;
  let disposed = false;
  onScopeDispose(() => {
    disposed = true;
  });

  async function save({ patch, signal }: { patch: TranslationPreferences, signal?: AbortSignal }): Promise<boolean> {
    if (disposed || saving.value) {
      return false;
    }
    // Save before exposing the new selection. Serial controls avoid optimistic
    // values being overwritten by an older queued settings write.
    const isCurrent = store.captureExperimentalStorage();
    const settled = Promise.withResolvers<void>();
    pending = settled.promise;
    saving.value = true;
    failed.value = false;
    try {
      const outcome = await store.updateExperimentalForStorage({
        isCurrent: () => !disposed && !signal?.aborted && isCurrent(),
        updater: ({ experimental }) => ({ ...experimental, translation: { ...experimental?.translation, ...patch } }),
      });
      return !disposed && !signal?.aborted && isCurrent() && outcome === 'saved';
    } catch {
      if (!disposed && isCurrent()) {
        failed.value = true;
      }
      return false;
    } finally {
      pending = undefined;
      saving.value = false;
      settled.resolve();
    }
  }

  async function waitForSave(): Promise<void> {
    while (pending !== undefined) {
      await pending;
    }
  }
  return {
    preferences,
    saving,
    failed,
    save,
    waitForSave,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
