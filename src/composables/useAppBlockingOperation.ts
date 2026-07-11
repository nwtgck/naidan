import { computed, readonly, shallowReactive } from 'vue';

export type AppBlockingOperation = 'storage_transition';

const activeOperations = shallowReactive(new Map<symbol, AppBlockingOperation>());
const active = computed(() => activeOperations.size > 0);

export function beginAppBlockingOperation({
  operation,
}: {
  operation: AppBlockingOperation,
}): () => void {
  const token = Symbol(operation);
  activeOperations.set(token, operation);
  let finished = false;

  return () => {
    if (finished) {
      return;
    }
    finished = true;
    activeOperations.delete(token);
  };
}

export function useAppBlockingOperation() {
  return {
    active: readonly(active),
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
  activeOperations,
};
