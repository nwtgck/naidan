import { onUnmounted, shallowRef } from 'vue';
import { prepareModelRemoval, type ModelRemovalRequest } from '@/features/llama-cpp-browser/runtime/model-store';
import type { DeletionPlan } from '@/features/llama-cpp-browser/runtime/deletion-plan';
export function useModelDeletionConfirm() {
  const request = shallowRef<ModelRemovalRequest>(); let disposed = false;
  let resolve: ReturnType<typeof Promise.withResolvers<DeletionPlan | undefined>>['resolve'] | undefined;
  function finish({ plan }: { plan: DeletionPlan | undefined }): void {
    request.value = undefined; resolve?.(plan); resolve = undefined;
  }
  onUnmounted(() => {
    disposed = true; finish({ plan: undefined });
  });
  async function confirmRemoval({ id }: { id: string }): Promise<DeletionPlan | undefined> {
    const prepared = await prepareModelRemoval({ id });
    if (disposed) return undefined;
    request.value = prepared;
    return new Promise(resolvePlan => {
      resolve = resolvePlan;
    });
  }
  return { request, finish, confirmRemoval, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}
export const TEST_ONLY = {
};
