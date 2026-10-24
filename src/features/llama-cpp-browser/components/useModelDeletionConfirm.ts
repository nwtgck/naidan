import { onUnmounted, shallowRef } from 'vue';
import { prepareModelRemoval, prepareRepositoryRemoval, type ModelRemovalRequest, type ModelRemovalTarget } from '@/features/llama-cpp-browser/runtime/model-store';
import type { DeletionPlan } from '@/features/llama-cpp-browser/runtime/deletion-plan';

export function useModelDeletionConfirm() {
  const request = shallowRef<ModelRemovalRequest>();
  let disposed = false;
  let stopAbort: (() => void) | undefined;
  let resolve: ReturnType<typeof Promise.withResolvers<DeletionPlan | undefined>>['resolve'] | undefined;
  function finish({ plan }: { plan: DeletionPlan | undefined }): void {
    stopAbort?.();
    stopAbort = undefined;
    request.value = undefined;
    resolve?.(plan);
    resolve = undefined;
  }
  onUnmounted(() => {
    disposed = true;
    finish({ plan: undefined });
  });
  async function confirmRemoval({ target, signal }: { target: ModelRemovalTarget, signal: AbortSignal | undefined }): Promise<DeletionPlan | undefined> {
    signal?.throwIfAborted();
    const prepared = await (async () => {
      switch (target.kind) {
      case 'model': return prepareModelRemoval({ modelId: target.modelId, signal });
      case 'repository': return prepareRepositoryRemoval({ location: target.location, signal });
      default: {
        const exhaustive: never = target;
        throw new Error(String(exhaustive));
      }
      }
    })();
    if (disposed || signal?.aborted) {
      return undefined;
    }
    return new Promise(resolvePlan => {
      resolve = resolvePlan;
      const abort = () => finish({ plan: undefined });
      signal?.addEventListener('abort', abort, { once: true });
      stopAbort = () => signal?.removeEventListener('abort', abort);
      request.value = prepared;
      if (signal?.aborted) {
        finish({ plan: undefined });
      }
    });
  }
  return { request, finish, confirmRemoval, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
