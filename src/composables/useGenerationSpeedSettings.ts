import { computed, readonly, ref } from 'vue';
import type { Settings } from '@/01-models/types';
import { ensureStrings } from '@/strings';
import { useSettings } from './useSettings';
import { useToast } from './useToast';

type GenerationSpeedSettings = NonNullable<NonNullable<Settings['experimental']>['generationSpeed']>;
const saving = ref(false);

export function useGenerationSpeedSettings() {
  const { settings, captureExperimentalStorage, updateExperimentalForStorage } = useSettings();
  const { addToast } = useToast();
  const status = computed(() => settings.value.experimental?.generationSpeed?.status ?? 'enabled');
  const inlineStats = computed(() => settings.value.experimental?.generationSpeed?.inlineStats ?? 'on_demand');

  async function update({ patch }: { patch: Partial<GenerationSpeedSettings> }): Promise<void> {
    if (saving.value) {
      return;
    }
    const isCurrent = captureExperimentalStorage();
    saving.value = true;
    try {
      await updateExperimentalForStorage({
        isCurrent,
        updater: ({ experimental }) => ({
          ...experimental,
          generationSpeed: { ...experimental?.generationSpeed, ...patch },
        }),
      });
    } catch {
      const message = await ensureStrings.GenerationSpeed__could_not_save_display_settings();
      if (isCurrent()) {
        addToast({ message });
      }
    } finally {
      saving.value = false;
    }
  }

  return { status, inlineStats, saving: readonly(saving), update, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
