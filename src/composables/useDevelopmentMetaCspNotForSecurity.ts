import { computed, nextTick, onScopeDispose, readonly, shallowRef } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { getDevelopmentMetaCspOwnerNotForSecurity } from '@/logic/development-meta-csp/owner';
import type { DevelopmentMetaCspSnapshotNotForSecurity } from '@/logic/development-meta-csp/types';

type SaveOutcome = 'saved' | 'changed' | 'failed' | 'busy';
const operation = shallowRef<'idle' | 'saving' | 'saved' | 'failed' | 'changed'>('idle');
let initializing: Promise<void> | undefined;
let isRecoveryResident: (() => boolean) | undefined;

/**
 * Late development instrumentation only. It cannot establish a secure loading
 * boundary and must never be used to improve security or control features.
 */
export function useDevelopmentMetaCspNotForSecurity() {
  const settingsStore = useSettings();
  const owner = getDevelopmentMetaCspOwnerNotForSecurity();
  const snapshot = shallowRef<DevelopmentMetaCspSnapshotNotForSecurity>(owner.getSnapshot());
  const unsubscribe = owner.subscribe({
    listener: () => {
      snapshot.value = owner.getSnapshot();
    },
  });
  onScopeDispose(() => unsubscribe?.());
  const savedSerialized = computed(() => settingsStore.settings.value.experimental?.metaCspForDevelopmentNotForSecurity);

  async function applySavedValue({ serialized, source, isCurrent }: { serialized: string | undefined, source: 'saved-setting' | 'developer-action', isCurrent(): boolean }): Promise<void> {
    if (serialized === undefined || (serialized.length <= 65_536 && serialized.trim() === '')) {
      return;
    }
    await owner.addForDevelopmentNotForSecurity({ serialized, source, isCurrent, isRecoveryResident: () => isRecoveryResident?.() === true });
  }

  async function saveDevelopmentMetaCspNotForSecurity({ serialized, isCurrent }: { serialized: string | undefined, isCurrent(): boolean }): Promise<SaveOutcome> {
    switch (operation.value) {
    case 'saving': return 'busy';
    case 'idle':
    case 'saved':
    case 'failed':
    case 'changed': break;
    default: {
      const exhaustive: never = operation.value;
      return exhaustive;
    }
    }
    operation.value = 'saving';
    try {
      const isStorageCurrent = settingsStore.captureExperimentalStorage();
      const stillCurrent = () => isStorageCurrent() && isCurrent();
      if (!stillCurrent()) {
        operation.value = 'changed';
        return 'changed';
      }
      if (serialized !== undefined && serialized.length > 65_536) {
        operation.value = 'failed';
        return 'failed';
      }
      const result = await settingsStore.updateExperimentalForStorage({
        isCurrent: stillCurrent,
        updater: ({ experimental }) => ({ ...experimental, metaCspForDevelopmentNotForSecurity: serialized }),
      });
      switch (result) {
      case 'changed': operation.value = 'changed';
        return 'changed';
      case 'saved':
        if (!stillCurrent()) {
          operation.value = 'changed';
          return 'changed';
        }
        // The first saved value also mounts the already prepared resident
        // recovery button. Let that DOM update finish before the native guard.
        await nextTick();
        if (!stillCurrent()) {
          operation.value = 'changed';
          return 'changed';
        }
        await applySavedValue({ serialized, source: 'developer-action', isCurrent: () => stillCurrent() && savedSerialized.value === serialized });
        if (!stillCurrent()) {
          operation.value = 'changed';
          return 'changed';
        }
        // Saving undefined does not remove any already enforced policy. People
        // may reload the page themselves when they want those policies removed.
        operation.value = 'saved';
        return 'saved';
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
      }
    } catch {
      operation.value = 'failed';
      return 'failed';
    }
  }

  return {
    snapshot: readonly(snapshot),
    additions: computed(() => snapshot.value.additions),
    savedSerialized: readonly(savedSerialized),
    operation: readonly(operation),
    captureStorageForDevelopmentMetaCspNotForSecurity(): () => boolean {
      return settingsStore.captureExperimentalStorage();
    },
    prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident: resident }: { isRecoveryResident(): boolean }): Promise<void> {
      if (!settingsStore.initialized.value) {
        return Promise.resolve();
      }
      isRecoveryResident = resident;
      initializing ??= Promise.resolve().then(async () => {
        try {
          if (!settingsStore.initialized.value || !isRecoveryResident?.()) {
            return;
          }
          const serialized = savedSerialized.value;
          const isStorageCurrent = settingsStore.captureExperimentalStorage();
          await applySavedValue({ serialized, source: 'saved-setting', isCurrent: () => isStorageCurrent() && savedSerialized.value === serialized });
        } catch {
          // Settings, chunks, parsing or resident setup failures skip meta CSP.
        }
      }).finally(() => {
        // Coalesce concurrent preparation only. Missing resident UI, a storage
        // change or a temporary parser failure must permit later recovery.
        initializing = undefined;
      });
      return initializing;
    },
    saveDevelopmentMetaCspNotForSecurity,
    clearDevelopmentMetaCspNotForSecurity(): Promise<SaveOutcome> {
      return saveDevelopmentMetaCspNotForSecurity({ serialized: undefined, isCurrent: settingsStore.captureExperimentalStorage() });
    },
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
