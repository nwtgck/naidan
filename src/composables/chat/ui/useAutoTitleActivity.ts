import { onScopeDispose } from 'vue';
import { autoTitleScheduler } from '@/composables/chat/global/auto-title-runtime';

/** ChatInput reports intent; it neither owns the title timer nor stores input text. */
export function useAutoTitleActivity() {
  const releases = new Set<() => void>();
  let releaseComposition: (() => void) | undefined;
  function hold(): () => void {
    const release = autoTitleScheduler.hold();
    const stop = () => {
      if (releases.delete(stop)) release();
    };
    releases.add(stop);
    return stop;
  }
  function endComposition(): void {
    releaseComposition?.();
    releaseComposition = undefined;
  }
  onScopeDispose(() => {
    for (const release of releases) release();
  });
  return {
    noteActivity: autoTitleScheduler.noteActivity,
    hold,
    beginComposition(): void {
      if (releaseComposition === undefined) releaseComposition = hold();
    },
    endComposition,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
