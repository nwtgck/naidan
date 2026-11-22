import { computed, ref, watch, type Ref } from 'vue';
import type { RepositoryDownloadUsage } from '@/features/llama-cpp-browser/hugging-face/repository-row-download';
import type { RepositoryModelSelection } from '@/features/llama-cpp-browser/model-launch/bundled-repository-target';

export function useRepositoryDownloadHint({ selection, usage }: { selection: Readonly<Ref<RepositoryModelSelection | undefined>>, usage: RepositoryDownloadUsage }) {
  const hidden = ref(false);
  watch(selection, (pending, _, onCleanup) => {
    hidden.value = false;
    if (pending === undefined) {
      return;
    }
    let current = true;
    let stop: (() => void) | undefined;
    onCleanup(() => {
      current = false;
      stop?.();
    });
    void import('@/features/llama-cpp-browser/model-launch/watch-repository-download-hint').then(({ watchRepositoryDownloadHint }) => {
      if (current) {
        stop = watchRepositoryDownloadHint({
          selection: pending,
          usage,
          update: ({ hidden: next }) => {
            hidden.value = next;
          },
        });
      }
    }).catch(() => {});
  }, { immediate: true });
  return computed(() => hidden.value);
}

export const TEST_ONLY = {
};
