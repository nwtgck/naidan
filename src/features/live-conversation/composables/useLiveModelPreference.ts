import { computed } from 'vue';
import { useSettings } from '@/composables/useSettings';

let tail = Promise.resolve();

/** Store only an explicitly chosen model, never a transcript, media, queue or
 * microphone preference. Guard delayed writes against a storage switch. */
export function useLiveModelPreference() {
  const settings = useSettings();
  const remembered = computed(() => settings.settings.value.experimental?.liveConversationModelId);
  function remember({ modelId }: { modelId: string }): Promise<void> {
    const isCurrent = settings.captureExperimentalStorage();
    const save = tail.then(async () => {
      await settings.updateExperimentalForStorage({
        isCurrent,
        updater: ({ experimental }) => ({ ...experimental, liveConversationModelId: modelId || undefined }),
      });
    });
    tail = save.catch(() => {});
    return save;
  }
  return { remembered, remember, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
