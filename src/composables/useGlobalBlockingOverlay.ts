import {
  shallowReadonly,
  shallowRef,
  type Component,
} from 'vue';
import {
  beginAppBlockingOperation,
  type AppBlockingOperation,
} from '@/composables/useAppBlockingOperation';

export interface GlobalBlockingOverlay {
  readonly component: Component,
}

const overlay = shallowRef<GlobalBlockingOverlay>();
let activeToken: symbol | undefined;

export function showGlobalBlockingOverlay({
  operation,
  component,
}: {
  operation: AppBlockingOperation,
  component: Component,
}): () => void {
  if (activeToken !== undefined) {
    throw new Error('A global blocking overlay is already active');
  }

  const token = Symbol('global-blocking-overlay');
  const finishBlockingOperation = beginAppBlockingOperation({ operation });
  activeToken = token;
  overlay.value = { component };
  let closed = false;

  return () => {
    if (closed) {
      return;
    }
    closed = true;
    if (activeToken === token) {
      activeToken = undefined;
      overlay.value = undefined;
    }
    finishBlockingOperation();
  };
}

export function useGlobalBlockingOverlay() {
  return {
    overlay: shallowReadonly(overlay),
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
    activeToken = undefined;
    overlay.value = undefined;
  },
};
