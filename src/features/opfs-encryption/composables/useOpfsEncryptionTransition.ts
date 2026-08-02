import {
  defineAsyncComponent,
  readonly,
  ref,
} from 'vue';
import { showGlobalBlockingOverlay } from '@/composables/useGlobalBlockingOverlay';
import type { OpfsEncryptionTransitionProgress } from '@/00-storage/service/naidan-opfs/transition-progress';

const OpfsEncryptionTransitionView = defineAsyncComponent(
  () => import('@/features/opfs-encryption/components/OpfsEncryptionTransitionView.vue'),
);

export type OpfsEncryptionTransitionOutcome =
  | 'preparation_failed'
  | 'settled_for_reload';

const active = ref(false);
const progress = ref<OpfsEncryptionTransitionProgress>();
let closeOverlay: (() => void) | undefined;
let operationOwner: 'local' | 'external' | undefined;

function closeLocalOverlay(): void {
  const close = closeOverlay;
  closeOverlay = undefined;
  operationOwner = undefined;
  close?.();
  active.value = false;
  progress.value = undefined;
}

export function useOpfsEncryptionTransition() {
  function beginOperation(): void {
    if (closeOverlay !== undefined) {
      throw new Error('An OPFS encryption transition is already active');
    }
    active.value = true;
    progress.value = undefined;
    closeOverlay = showGlobalBlockingOverlay({
      operation: 'storage_transition',
      component: OpfsEncryptionTransitionView,
    });
  }

  function beginLocalOperation(): void {
    beginOperation();
    operationOwner = 'local';
  }

  function beginExternalOperation(): void {
    if (closeOverlay !== undefined) {
      // Two tabs may request a transition at nearly the same time. The tab
      // that loses the global storage lock already has its local overlay open
      // when it receives the winner's external-start notification. Reuse that
      // presentation so external preparation can continue and release the
      // shared OPFS session lock instead of failing into a cross-tab deadlock.
      active.value = true;
      progress.value = undefined;
      operationOwner = 'external';
      return;
    }
    beginOperation();
    operationOwner = 'external';
  }


  function updateProgress({
    progress: nextProgress,
  }: {
    progress: OpfsEncryptionTransitionProgress,
  }): void {
    progress.value = nextProgress;
  }

  function finishLocalOperation({
    outcome,
  }: {
    outcome: OpfsEncryptionTransitionOutcome,
  }): void {
    const owner = operationOwner;
    switch (owner) {
    case 'local':
      break;
    case 'external':
    case undefined:
      // A competing tab may have won the global lock and taken ownership of
      // this overlay. Ignore the stale local completion so the suspended app
      // stays covered until the external settlement reload completes.
      return;
    default: {
      const _ex: never = owner;
      return _ex;
    }
    }
    switch (outcome) {
    case 'preparation_failed':
      closeLocalOverlay();
      return;
    case 'settled_for_reload':
      // StorageService has notified the central reload guard. Keep the page
      // inert until navigation replaces this runtime, regardless of outcome.
      active.value = true;
      return;
    default: {
      const _ex: never = outcome;
      return _ex;
    }
    }
  }

  return {
    active: readonly(active),
    progress: readonly(progress),
    beginLocalOperation,
    beginExternalOperation,
    updateProgress,
    finishLocalOperation,
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
  reset(): void {
    closeLocalOverlay();
  },
};
