import { onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { errorCode, type ErrorCode } from '@/features/llama-cpp-browser/types';
import { useModelDeletionConfirm } from '@/features/llama-cpp-browser/components/useModelDeletionConfirm';
import { isPendingLocalModelReference } from '@/features/llama-cpp-browser/local-repository-reference';

/** The same deletion plan and confirmation apply wherever a model is listed. */
export function useModelRemoval({ suspended, disabled, refresh }: { suspended: Readonly<Ref<boolean>>, disabled: Readonly<Ref<boolean>>, refresh(): Promise<void> }) {
  const active = shallowRef<AbortController>();
  const error = ref<ErrorCode>();
  const changed = ref(false);
  const { request, finish, confirmRemoval } = useModelDeletionConfirm();
  function cancel(): void {
    active.value?.abort();
    finish({ plan: undefined });
  }
  watch(suspended, value => {
    if (value) {
      cancel();
    }
  }, { flush: 'sync' });
  onScopeDispose(cancel);

  async function remove({ modelId }: { modelId: string }): Promise<void> {
    if (suspended.value || disabled.value || active.value !== undefined) {
      return;
    }
    const controller = new AbortController();
    active.value = controller;
    error.value = undefined;
    changed.value = false;
    try {
      if (isPendingLocalModelReference({ modelId })) {
        await llamaCppBrowserModelFiles.removeTemporaryModel({ modelId, signal: controller.signal });
      } else {
        const plan = await confirmRemoval({ target: { kind: 'model', modelId }, signal: controller.signal });
        if (plan === undefined || controller.signal.aborted) {
          return;
        }
        const result = await llamaCppBrowserModelFiles.removeModel({ plan, signal: controller.signal });
        switch (result) {
        case 'deleted': break;
        case 'changed': changed.value = true;
          break;
        default: {
          const exhaustive: never = result;
          throw new Error(String(exhaustive));
        }
        }
      }
      if (!controller.signal.aborted) {
        await refresh();
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        error.value = errorCode({ error: failure });
      }
    } finally {
      active.value = undefined;
    }
  }
  return { active, error, changed, request, finish, remove, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
