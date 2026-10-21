import { onUnmounted, shallowRef } from 'vue';
import { prepareModelRemoval, prepareRepositoryRemoval, type ModelRemovalRequest, type ModelRemovalTarget } from '@/features/llama-cpp-browser/runtime/model-store';
import type { DeletionPlan } from '@/features/llama-cpp-browser/runtime/deletion-plan';

export function useModelDeletionConfirm() {
  const request = shallowRef<ModelRemovalRequest>();
  let disposed = false;
  let resolve: ReturnType<typeof Promise.withResolvers<DeletionPlan | undefined>>['resolve'] | undefined;
  function finish({ plan }: { plan: DeletionPlan | undefined }): void {
    request.value = undefined;
    resolve?.(plan);
    resolve = undefined;
  }
  onUnmounted(() => {
    disposed = true;
    finish({ plan: undefined });
  });
  async function confirmRemoval({ target }: { target: ModelRemovalTarget }): Promise<DeletionPlan | undefined> {
    const prepared = await (async () => {
      switch (target.kind) {
      case 'model': return prepareModelRemoval({ modelId: target.modelId, signal: undefined });
      case 'repository': return prepareRepositoryRemoval({ location: target.location, signal: undefined });
      default: {
        const exhaustive: never = target;
        throw new Error(String(exhaustive));
      }
      }
    })();
    if (disposed) {
      return undefined;
    }
    request.value = prepared;
    return new Promise(resolvePlan => {
      resolve = resolvePlan;
    });
  }
  return { request, finish, confirmRemoval, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
