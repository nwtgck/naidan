import { computed, ref, shallowRef } from 'vue';
import { useOverlay } from '@/composables/useOverlay';

const { activeOverlay, openOverlay, closeOverlay } = useOverlay();
const view = ref<'entries' | 'developer'>('entries');
const opener = shallowRef<HTMLElement>();
const isLauncherOpen = computed(() => activeOverlay.value === 'launcher');

export function useLauncher() {
  function openLauncher({ view: next }: { view: 'entries' | 'developer' }): void {
    opener.value = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    view.value = next;
    openOverlay({ type: 'launcher' });
  }

  function closeLauncher(): void {
    if (isLauncherOpen.value) {
      closeOverlay();
    }
  }

  return {
    isLauncherOpen,
    view,
    opener,
    openLauncher,
    closeLauncher,
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
