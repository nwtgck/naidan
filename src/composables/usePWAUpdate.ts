import { computed, shallowRef } from 'vue';

export type PWAUpdateState =
  | { kind: 'idle' }
  | { kind: 'preparing'; handler?: () => Promise<void> }
  | { kind: 'ready'; handler: () => Promise<void> };

type InternalUpdateState = PWAUpdateState | { kind: 'applying' };

// Page-scoped state survives Sidebar and post-startup UI remounts. Publish the
// action and availability atomically. Preparing permits ONLY an explicit
// network-update action; it never activates an uninstalled service worker.
const state = shallowRef<InternalUpdateState>({ kind: 'idle' });
const status = computed(() => state.value.kind);
const canUpdate = computed(() => (state.value.kind === 'ready' || state.value.kind === 'preparing') && state.value.handler !== undefined);

export function usePWAUpdate() {
  function setUpdateState({ next }: { next: PWAUpdateState }): void {
    state.value = next;
  }

  async function update(): Promise<void> {
    const current = state.value;
    switch (current.kind) {
    case 'idle':
    case 'applying':
      return;
    case 'preparing':
    case 'ready': {
      if (!current.handler) return;
      const applying = { kind: 'applying' } as const;
      state.value = applying;
      try {
        await current.handler();
        // The service worker controls the eventual reload. Do not enable a
        // second click merely because sending SKIP_WAITING has completed.
      } catch (error) {
        if (state.value === applying) state.value = current;
        throw error;
      }
      return;
    }
    default: {
      const exhaustive: never = current;
      throw new Error(String(exhaustive));
    }
    }
  }

  return {
    status,
    canUpdate,
    update,
    setUpdateState,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
