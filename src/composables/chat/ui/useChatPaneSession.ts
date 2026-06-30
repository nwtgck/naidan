import { getCurrentInstance, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import type { MessageId } from '@/01-models/ids';

type OutlineVisibility = 'hidden' | 'visible';

interface ChatPaneSession {
  showCompactSettings: Ref<boolean>,
  showNeuralSyncEffect: Ref<boolean>,
  outlineVisibility: Ref<OutlineVisibility>,
  initialOutlineMessageId: Ref<MessageId | undefined>,
  openCompactSettings: () => void,
  closeCompactSettings: () => void,
  toggleOutline: ({ getCurrentViewportMessageId }: { getCurrentViewportMessageId: () => MessageId | undefined }) => void,
  closeOutline: () => void,
  playNeuralSyncEffect: () => void,
  clearNeuralSyncEffect: () => void,
  TEST_ONLY: {
    hideNeuralSyncEffectTimer: Ref<number | undefined>,
    clearNeuralSyncEffectTimer: () => void,
  },
}

export function useChatPaneSession({
  chatIdentityKey,
}: {
  chatIdentityKey: Readonly<Ref<string>>,
}): ChatPaneSession {
  const showCompactSettings = ref(false);
  const showNeuralSyncEffect = ref(false);
  const outlineVisibility = ref<OutlineVisibility>('hidden');
  const initialOutlineMessageId = ref<MessageId | undefined>(undefined);
  const hideNeuralSyncEffectTimer = ref<number | undefined>(undefined);

  function clearNeuralSyncEffectTimer() {
    if (hideNeuralSyncEffectTimer.value === undefined) return;
    window.clearTimeout(hideNeuralSyncEffectTimer.value);
    hideNeuralSyncEffectTimer.value = undefined;
  }

  function clearNeuralSyncEffect() {
    clearNeuralSyncEffectTimer();
    showNeuralSyncEffect.value = false;
  }

  function playNeuralSyncEffect() {
    clearNeuralSyncEffectTimer();
    showNeuralSyncEffect.value = true;
    hideNeuralSyncEffectTimer.value = window.setTimeout(() => {
      showNeuralSyncEffect.value = false;
      hideNeuralSyncEffectTimer.value = undefined;
    }, 1200);
  }

  function openCompactSettings() {
    showCompactSettings.value = true;
  }

  function closeCompactSettings() {
    showCompactSettings.value = false;
  }

  function toggleOutline({
    getCurrentViewportMessageId,
  }: {
    getCurrentViewportMessageId: () => MessageId | undefined,
  }) {
    const currentVisibility = outlineVisibility.value;
    switch (currentVisibility) {
    case 'visible':
      outlineVisibility.value = 'hidden';
      initialOutlineMessageId.value = undefined;
      return;
    case 'hidden':
      initialOutlineMessageId.value = getCurrentViewportMessageId();
      outlineVisibility.value = 'visible';
      return;
    default: {
      const _ex: never = currentVisibility;
      throw new Error(`Unhandled outline visibility: ${_ex}`);
    }
    }
  }

  function closeOutline() {
    outlineVisibility.value = 'hidden';
    initialOutlineMessageId.value = undefined;
  }

  watch(chatIdentityKey, () => {
    closeCompactSettings();
    closeOutline();
    clearNeuralSyncEffect();
  });

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      clearNeuralSyncEffect();
    });
  }

  return {
    showCompactSettings,
    showNeuralSyncEffect,
    outlineVisibility,
    initialOutlineMessageId,
    openCompactSettings,
    closeCompactSettings,
    toggleOutline,
    closeOutline,
    playNeuralSyncEffect,
    clearNeuralSyncEffect,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        hideNeuralSyncEffectTimer,
        clearNeuralSyncEffectTimer,
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
