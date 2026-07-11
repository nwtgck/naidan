import { readonly, ref } from 'vue';
import { storageService } from '@/00-storage/service';

const active = ref(false);
const localOperation = ref(false);
const failed = ref(false);
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) {
    return;
  }
  subscribed = true;
  storageService.subscribeToChanges({ listener: ({ event }) => {
    switch (event.type) {
    case 'chat_meta_and_chat_group':
    case 'chat_content':
    case 'chat_content_generation':
    case 'settings':
    case 'binary_objects':
    case 'migration':
      return;
    case 'opfs_encryption':
      break;
    default: {
      const _ex: never = event;
      throw new Error(`Unhandled storage change event: ${((_ex satisfies never) as { readonly type: string }).type}`);
    }
    }

    const status = event.status;
    switch (status) {
    case 'transition_started':
      active.value = true;
      failed.value = false;
      if (!localOperation.value && typeof window !== 'undefined') {
        window.location.reload();
      }
      break;
    case 'transition_completed':
      active.value = false;
      failed.value = false;
      if (!localOperation.value && typeof window !== 'undefined') {
        window.location.reload();
      }
      break;
    case 'transition_failed':
      active.value = true;
      failed.value = true;
      if (!localOperation.value && typeof window !== 'undefined') {
        window.location.reload();
      }
      break;
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled OPFS encryption transition status: ${String(_ex)}`);
    }
    }
  } });
}

export function useOpfsEncryptionTransition() {
  ensureSubscribed();

  function beginLocalOperation(): void {
    localOperation.value = true;
    active.value = true;
    failed.value = false;
  }

  function finishLocalOperation({ success }: { success: boolean }): void {
    localOperation.value = false;
    active.value = !success;
    failed.value = !success;
    if (!success && typeof window !== 'undefined') {
      window.location.reload();
    }
  }

  return {
    active: readonly(active),
    failed: readonly(failed),
    beginLocalOperation,
    finishLocalOperation,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
