import { computed, readonly, ref } from 'vue';
import { ensureStrings } from '@/strings';
import { useSettings } from './useSettings';
import { useToast } from './useToast';

const saving = ref(false);

export function useLauncherSettings() {
  const { settings, captureExperimentalStorage, updateExperimentalForStorage } = useSettings();
  const { addToast } = useToast();
  const unimplementedLauncherEntries = computed(() => settings.value.experimental?.unimplementedLauncherEntries ?? 'hide');

  async function update({ visibility }: { visibility: 'show' | 'hide' }): Promise<void> {
    if (saving.value) {
      return;
    }
    const isCurrent = captureExperimentalStorage();
    saving.value = true;
    try {
      await updateExperimentalForStorage({
        isCurrent,
        updater: ({ experimental }) => ({ ...experimental, unimplementedLauncherEntries: visibility }),
      });
    } catch {
      const message = await ensureStrings.LauncherSettings__could_not_save_display_settings();
      if (isCurrent()) {
        addToast({ message });
      }
    } finally {
      saving.value = false;
    }
  }

  return { unimplementedLauncherEntries, saving: readonly(saving), update, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
