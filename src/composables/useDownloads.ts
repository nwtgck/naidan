import { onScopeDispose, shallowReadonly, shallowRef } from 'vue';
import { getDownloadManager } from '@/logic/download-manager';

export function useDownloads() {
  const manager = getDownloadManager();
  const jobs = shallowRef(manager.snapshot());
  const unsubscribe = manager.subscribe({
    listener: () => {
      jobs.value = manager.snapshot();
    },
  });
  onScopeDispose(unsubscribe);
  return {
    jobs: shallowReadonly(jobs),
    manager,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export const TEST_ONLY = {
};
