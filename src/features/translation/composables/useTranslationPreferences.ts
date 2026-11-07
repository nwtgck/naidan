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
  let disposed = false;
  onScopeDispose(() => {
    disposed = true;
  });

  async function save({ patch }: { patch: TranslationPreferences }): Promise<boolean> {
    if (disposed || saving.value) {
      return false;
    }
    // Save before exposing the new selection. Serial controls avoid optimistic
    // values being overwritten by an older queued settings write.
    const isCurrent = store.captureExperimentalStorage();
    saving.value = true;
    failed.value = false;
    try {
      const outcome = await store.updateExperimentalForStorage({
        isCurrent: () => !disposed && isCurrent(),
        updater: ({ experimental }) => ({ ...experimental, translation: { ...experimental?.translation, ...patch } }),
      });
      return !disposed && isCurrent() && outcome === 'saved';
    } catch {
      if (!disposed && isCurrent()) {
        failed.value = true;
      }
      return false;
    } finally {
      saving.value = false;
    }
  }
  return {
    preferences,
    saving,
    failed,
    save,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
