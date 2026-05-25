import { computed, nextTick, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatAreaSession } from './chat-area-session';

describe('useChatAreaSession', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('resets compact dialog, outline, and neural sync effect when chat identity changes', async () => {
    vi.useFakeTimers();
    try {
      const currentChatId = ref<string | undefined>('chat-1');
      const currentLeafId = ref<string | undefined>('leaf-1');
      const session = useChatAreaSession({
        chatId: computed(() => currentChatId.value),
        leafId: computed(() => currentLeafId.value),
      });

      session.openCompactSettings({});
      session.toggleOutline({
        getCurrentViewportMessageId: () => 'message-1',
      });
      session.playNeuralSyncEffect({});

      expect(session.showCompactSettings.value).toBe(true);
      expect(session.outlineVisibility.value).toBe('visible');
      expect(session.initialOutlineMessageId.value).toBe('message-1');
      expect(session.showNeuralSyncEffect.value).toBe(true);

      currentChatId.value = 'chat-2';
      await nextTick();

      expect(session.showCompactSettings.value).toBe(false);
      expect(session.outlineVisibility.value).toBe('hidden');
      expect(session.initialOutlineMessageId.value).toBeUndefined();
      expect(session.showNeuralSyncEffect.value).toBe(false);
      expect(session.TEST_ONLY.hideNeuralSyncEffectTimer.value).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the neural sync effect after the timer expires', async () => {
    vi.useFakeTimers();
    try {
      const session = useChatAreaSession({
        chatId: computed(() => 'chat-1'),
        leafId: computed(() => 'leaf-1'),
      });

      session.playNeuralSyncEffect({});
      expect(session.showNeuralSyncEffect.value).toBe(true);

      await vi.advanceTimersByTimeAsync(1200);

      expect(session.showNeuralSyncEffect.value).toBe(false);
      expect(session.TEST_ONLY.hideNeuralSyncEffectTimer.value).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures the viewport message when opening the outline and clears it when closing', () => {
    const session = useChatAreaSession({
      chatId: computed(() => 'chat-1'),
      leafId: computed(() => 'leaf-1'),
    });

    session.toggleOutline({
      getCurrentViewportMessageId: () => 'message-42',
    });

    expect(session.outlineVisibility.value).toBe('visible');
    expect(session.initialOutlineMessageId.value).toBe('message-42');

    session.closeOutline({});

    expect(session.outlineVisibility.value).toBe('hidden');
    expect(session.initialOutlineMessageId.value).toBeUndefined();
  });
});
