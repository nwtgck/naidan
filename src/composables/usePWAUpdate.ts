import { computed, shallowRef } from 'vue';

export type PWAUpdateState =
  | { kind: 'idle' }
  | { kind: 'preparing'; handler?: () => Promise<void> }
  | { kind: 'ready'; handler: () => Promise<void> };

// Availability and the in-flight click are independent. Lifecycle events may
// replace the action while it runs, without allowing a second concurrent click.
const state = shallowRef<PWAUpdateState>({ kind: 'idle' });
const applying = shallowRef(false);
const status = computed(() => applying.value ? 'applying' : state.value.kind);
const canUpdate = computed(() => !applying.value && state.value.kind !== 'idle' && state.value.handler !== undefined);

export function usePWAUpdate() {
  function setUpdateState({ next }: { next: PWAUpdateState }): void {
    state.value = next;
  }
  async function update(): Promise<void> {
    const current = state.value;
    if (applying.value || current.kind === 'idle' || !current.handler) return;
    applying.value = true;
    try {
      await current.handler();
    } finally {
      // Handlers await actual activation/acknowledgement and request the reload.
      // If navigation is cancelled, keep the CURRENT action usable, not an
      // everlasting "applying" flag or a restored obsolete action.
      applying.value = false;
    }
  }
  return { status, canUpdate, update, setUpdateState,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
