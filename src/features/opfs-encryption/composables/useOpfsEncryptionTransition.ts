import {
  defineAsyncComponent,
  readonly,
  ref,
} from 'vue';
import { showGlobalBlockingOverlay } from '@/composables/useGlobalBlockingOverlay';

const OpfsEncryptionTransitionView = defineAsyncComponent(
  () => import('@/features/opfs-encryption/components/OpfsEncryptionTransitionView.vue'),
);

const active = ref(false);
const failed = ref(false);
let closeOverlay: (() => void) | undefined;

export function useOpfsEncryptionTransition() {
  function beginLocalOperation(): void {
    if (closeOverlay !== undefined) {
      throw new Error('An OPFS encryption transition is already active');
    }
    active.value = true;
    failed.value = false;
    closeOverlay = showGlobalBlockingOverlay({
      operation: 'storage_transition',
      component: OpfsEncryptionTransitionView,
    });
  }

  function finishLocalOperation({ success }: { success: boolean }): void {
    if (success) {
      const close = closeOverlay;
      closeOverlay = undefined;
      close?.();
      active.value = false;
      failed.value = false;
      return;
    }

    // Keep the app inert and the transition overlay visible until the reload
    // begins. If navigation is delayed or rejected, exposing the old backend
    // again would allow writes against an uncertain storage state.
    active.value = true;
    failed.value = true;
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }

  return {
    active: readonly(active),
    failed: readonly(failed),
    beginLocalOperation,
    finishLocalOperation,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  reset(): void {
    closeOverlay?.();
    closeOverlay = undefined;
    active.value = false;
    failed.value = false;
  },
};
