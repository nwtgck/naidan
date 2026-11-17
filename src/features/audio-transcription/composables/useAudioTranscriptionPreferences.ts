import { computed, readonly, ref } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { useToast } from '@/composables/useToast';
import { ensureStrings } from '@/strings';

const saving = ref(false);

export function useAudioTranscriptionPreferences() {
  const { settings, captureExperimentalStorage, updateExperimentalForStorage } = useSettings();
  const { addToast } = useToast();
  const autoCopy = computed(() => settings.value.experimental?.audioTranscription?.microphoneAutoCopy ?? 'disabled');

  async function updateAutoCopy({ value }: { value: 'enabled' | 'disabled' }): Promise<void> {
    if (saving.value) {
      return;
    }
    const isCurrent = captureExperimentalStorage();
    saving.value = true;
    try {
      await updateExperimentalForStorage({
        isCurrent,
        updater: ({ experimental }) => ({ ...experimental, audioTranscription: { ...experimental?.audioTranscription, microphoneAutoCopy: value } }),
      });
    } catch {
      const message = await ensureStrings.useAudioTranscriptionPreferences__could_not_save_auto_copy();
      if (isCurrent()) {
        addToast({ message });
      }
    } finally {
      saving.value = false;
    }
  }

  return { autoCopy, saving: readonly(saving), updateAutoCopy, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
