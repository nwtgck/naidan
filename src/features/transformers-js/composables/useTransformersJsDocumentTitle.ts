import { computed, onScopeDispose, ref, type ComputedRef } from 'vue';
import { useDocumentTitleOverride } from '@/composables/useDocumentMetadata';
import { transformersJsService } from '@/features/transformers-js';
import { lazyStrings } from '@/strings';

export function useTransformersJsDocumentTitle({ routePath, visibility }: {
  routePath: ComputedRef<string>,
  visibility: ComputedRef<'visible' | 'hidden'>,
}): void {
  const initial = transformersJsService.getState();
  const status = ref(initial.status);
  const progress = ref(initial.progress);
  const unsubscribe = transformersJsService.subscribe({
    listener: ({ status: nextStatus, progress: nextProgress }) => {
      status.value = nextStatus;
      progress.value = nextProgress;
    },
  });
  onScopeDispose(unsubscribe);
  useDocumentTitleOverride({
    kind: 'model-loading',
    source: computed(() => {
      if (visibility.value !== 'visible' || status.value !== 'loading') {
        return undefined;
      }
      const title = lazyStrings.TransformersJsLoadingIndicator__loading_model_progress({ progress: progress.value });
      return title === undefined ? undefined : { routePath: routePath.value, title };
    }),
  });
}

export const TEST_ONLY = {
};
