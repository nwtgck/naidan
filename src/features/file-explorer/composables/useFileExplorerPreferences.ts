import { computed, shallowRef } from 'vue';
import { useSettings } from '@/composables/useSettings';
import type { Settings } from '@/01-models/types';

type FileExplorerPreferences = NonNullable<NonNullable<Settings['experimental']>['fileExplorer']>;
type PreferenceChange = { patch: FileExplorerPreferences, isCurrent: () => boolean };
const pendingChanges = shallowRef<readonly PreferenceChange[]>([]);
let saveTail = Promise.resolve();

export function useFileExplorerPreferences() {
  const { settings, initialized, captureExperimentalStorage, updateExperimentalForStorage } = useSettings();
  const preferences = computed(() => {
    let result = settings.value.experimental?.fileExplorer;
    for (const change of pendingChanges.value) {
      if (change.isCurrent()) {
        result = { ...result, ...change.patch };
      }
    }
    return result;
  });

  function captureStorage(): () => boolean {
    return initialized.value ? captureExperimentalStorage() : () => !initialized.value;
  }

  async function savePreferences({ patch, isCurrent }: {
    patch: FileExplorerPreferences,
    isCurrent: () => boolean,
  }): Promise<void> {
    if (!initialized.value || !isCurrent()) {
      return;
    }
    const change = { patch, isCurrent };
    pendingChanges.value = [...pendingChanges.value, change];
    const write = saveTail.then(async () => {
      try {
        if (isCurrent()) {
          await updateExperimentalForStorage({
            isCurrent,
            updater: ({ experimental }) => ({
              ...experimental,
              fileExplorer: { ...experimental?.fileExplorer, ...patch },
            }),
          });
        }
      } catch {
        // Settings storage reports write failures through the global error handler.
      } finally {
        pendingChanges.value = pendingChanges.value.filter(candidate => candidate !== change);
      }
    });
    saveTail = write;
    await write;
  }

  return {
    preferences,
    initialized,
    captureStorage,
    savePreferences,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
