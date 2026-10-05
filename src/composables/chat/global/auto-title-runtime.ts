import { watch } from 'vue';
import { createAutoTitleScheduler } from '@/logic/auto-title-scheduler';

// Keep input activity independent of storage and chat-data-store initialization.
export const autoTitleScheduler = createAutoTitleScheduler({
  quietMs: 2500,
  now: () => performance.now(),
  onError: ({ error }) => console.warn('[auto-title] Title generation failed:', error),
});

export function observeAutoTitleForeground({ isBusy }: { isBusy: () => boolean }): () => void {
  // Synchronous observation preempts titles before a new user request can be
  // enqueued, including callers which never mount ChatInput.
  return watch(isBusy, busy => {
    autoTitleScheduler.setForeground({ state: busy ? 'busy' : 'idle' });
  }, { flush: 'sync', immediate: true });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
