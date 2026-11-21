import { computed, readonly, ref } from 'vue';
import { useSettings } from '@/composables/useSettings';

export function useHuggingFaceModelSearchPreferences() {
  const { settings, captureExperimentalStorage, updateExperimentalForStorage } = useSettings();
  const autoSearch = computed(() => settings.value.experimental?.huggingFaceModelSearch?.autoSearch === 'enabled');
  const saving = ref(false);
  const saveFailed = ref(false);

  async function setAutoSearch({ enabled }: { enabled: boolean }): Promise<void> {
    if (saving.value) {
      return;
    }
    saving.value = true;
    saveFailed.value = false;
    try {
      await updateExperimentalForStorage({
        isCurrent: captureExperimentalStorage(),
        updater: ({ experimental }) => ({
          ...experimental,
          huggingFaceModelSearch: { ...experimental?.huggingFaceModelSearch, autoSearch: enabled ? 'enabled' : 'disabled' },
        }),
      });
    } catch {
      saveFailed.value = true;
    } finally {
      saving.value = false;
    }
  }

  return { autoSearch, saving: readonly(saving), saveFailed: readonly(saveFailed), setAutoSearch, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
