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
  | 'completed'
  | 'rolled_back'
  | 'recovery_required';

const active = ref(false);
const failed = ref(false);
const failureMessage = ref<string>();
const progress = ref<OpfsEncryptionTransitionProgress>();
let closeOverlay: (() => void) | undefined;
let operationOwner: 'local' | 'external' | undefined;

function closeLocalOverlay(): void {
  const close = closeOverlay;
  closeOverlay = undefined;
  operationOwner = undefined;
  close?.();
  active.value = false;
  failed.value = false;
  failureMessage.value = undefined;
  progress.value = undefined;
}

export function useOpfsEncryptionTransition() {
  function beginOperation(): void {
    if (closeOverlay !== undefined) {
      throw new Error('An OPFS encryption transition is already active');
    }
    active.value = true;
    failed.value = false;
    failureMessage.value = undefined;
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
      failed.value = false;
      failureMessage.value = undefined;
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
    errorMessage,
  }: {
    outcome: OpfsEncryptionTransitionOutcome,
    errorMessage: string | undefined,
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
    case 'completed':
    case 'rolled_back':
      closeLocalOverlay();
      return;
    case 'recovery_required':
      // The provider could not prove that a normal backend is safe to expose.
      // Keep the application inert and preserve the raw OPFS recovery path
      // instead of reloading into an equally uncertain startup state.
      active.value = true;
      failed.value = true;
      failureMessage.value = errorMessage;
      return;
    default: {
      const _ex: never = outcome;
      return _ex;
    }
    }
  }

  return {
    active: readonly(active),
    failed: readonly(failed),
    failureMessage: readonly(failureMessage),
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
