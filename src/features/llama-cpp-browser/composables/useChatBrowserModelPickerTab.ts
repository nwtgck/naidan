import { computed, shallowRef } from 'vue';
import type { Settings } from '@/01-models/types';
import { useSettings } from '@/composables/useSettings';

export type ChatBrowserModelPickerTab = NonNullable<NonNullable<Settings['experimental']>['chatBrowserModelPickerTab']>;
const pending = shallowRef<{ tab: ChatBrowserModelPickerTab, isCurrent(): boolean }>();
let saveTail = Promise.resolve();

/** Only the source tab is remembered; model selection and open state stay local. */
export function useChatBrowserModelPickerTab() {
  const settings = useSettings();
  const remembered = computed(() => {
    const stored = settings.settings.value.experimental?.chatBrowserModelPickerTab ?? 'files';
    return pending.value?.isCurrent() ? pending.value.tab : stored;
  });

  function remember({ tab }: { tab: ChatBrowserModelPickerTab }): Promise<void> {
    const selection = { tab, isCurrent: settings.captureExperimentalStorage() };
    pending.value = selection;
    const save = saveTail.then(async () => {
      await settings.updateExperimentalForStorage({
        isCurrent: selection.isCurrent,
        updater: ({ experimental }) => ({ ...experimental, chatBrowserModelPickerTab: tab }),
      });
    });
    saveTail = save.catch(() => {});
    void save.finally(() => {
      if (pending.value === selection) {
        pending.value = undefined;
      }
    }).catch(() => {});
    return save;
  }

  return { remembered, remember, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
