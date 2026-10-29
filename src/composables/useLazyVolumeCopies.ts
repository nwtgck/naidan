import { computed, onScopeDispose, ref, type Ref } from 'vue';
import type { VolumeId } from '@/01-models/ids';
import { listLazyVolumeStates, subscribeLazyVolumeState } from '@/00-storage/service/lazy-volume-state';

/** Observe page-local copy state without loading the managed filesystem. */
export function useLazyVolumeCopies({ volumeIds }: { volumeIds: Readonly<Ref<readonly VolumeId[]>> | undefined }) {
  const revision = ref(0);
  const unsubscribe = subscribeLazyVolumeState({
    listener: ({ volumeId }) => {
      if (volumeIds === undefined || volumeIds.value.includes(volumeId)) {
        revision.value++;
      }
    },
  });
  onScopeDispose(unsubscribe);

  const states = computed(() => {
    void revision.value;
    const ids = volumeIds?.value;
    return listLazyVolumeStates().filter(state => ids === undefined || ids.includes(state.volume.id));
  });
  const pendingStates = computed(() => states.value.filter(state => state.phase !== 'saved'));

  return {
    states,
    pendingStates,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export const TEST_ONLY = {
};
