import { readonly, shallowRef } from 'vue';

type OfflineAssetStatus = 'unavailable' | 'idle' | 'saving' | 'complete' | 'failed';
const status = shallowRef<OfflineAssetStatus>('unavailable');
let save: (() => Promise<void>) | undefined;

export function usePWAOfflineAssets() {
  return {
    status: readonly(status),
    async saveRemaining() {
      await save?.();
    },
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export function setOfflineAssetAction({ action }: { action: (() => Promise<void>) | undefined }): void {
  save = action;
  status.value = action ? 'idle' : 'unavailable';
}

export function setOfflineAssetStatus({ next }: { next: OfflineAssetStatus }): void {
  status.value = next;
}

export const TEST_ONLY = {
};
