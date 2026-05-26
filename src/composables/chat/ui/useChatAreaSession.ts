import { getCurrentInstance, onBeforeUnmount, ref, watch, type Ref } from 'vue';

type OutlineVisibility = 'hidden' | 'visible';

export function useChatAreaSession({
  chatId,
  leafId,
}: {
  chatId: Ref<string | undefined>;
  leafId: Ref<string | undefined>;
}) {
  const showCompactSettings = ref(false);
  const showNeuralSyncEffect = ref(false);
  const outlineVisibility = ref<OutlineVisibility>('hidden');
  const initialOutlineMessageId = ref<string | undefined>(undefined);
  const hideNeuralSyncEffectTimer = ref<number | undefined>(undefined);

  function clearNeuralSyncEffectTimer(_args: Record<never, never>) {
    if (hideNeuralSyncEffectTimer.value === undefined) return;
    window.clearTimeout(hideNeuralSyncEffectTimer.value);
    hideNeuralSyncEffectTimer.value = undefined;
  }

  function clearNeuralSyncEffect(_args: Record<never, never>) {
    clearNeuralSyncEffectTimer({});
    showNeuralSyncEffect.value = false;
  }

  function playNeuralSyncEffect(_args: Record<never, never>) {
    clearNeuralSyncEffectTimer({});
    showNeuralSyncEffect.value = true;
    hideNeuralSyncEffectTimer.value = window.setTimeout(() => {
      showNeuralSyncEffect.value = false;
      hideNeuralSyncEffectTimer.value = undefined;
    }, 1200);
  }

  function openCompactSettings(_args: Record<never, never>) {
    showCompactSettings.value = true;
  }

  function closeCompactSettings(_args: Record<never, never>) {
    showCompactSettings.value = false;
  }

  function toggleOutline({
    getCurrentViewportMessageId,
  }: {
    getCurrentViewportMessageId: () => string | undefined;
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

  function closeOutline(_args: Record<never, never>) {
    outlineVisibility.value = 'hidden';
    initialOutlineMessageId.value = undefined;
  }

  watch([chatId, leafId], () => {
    closeCompactSettings({});
    closeOutline({});
    clearNeuralSyncEffect({});
  });

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      clearNeuralSyncEffect({});
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
    TEST_ONLY: {
      hideNeuralSyncEffectTimer,
      clearNeuralSyncEffectTimer,
    },
  };
}
