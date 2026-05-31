import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockToggleDebugForChatId,
} = vi.hoisted(() => ({
  mockToggleDebugForChatId: vi.fn(),
}));

vi.mock('./chat-metadata-helpers', () => ({
  toggleDebugForChatId: mockToggleDebugForChatId,
}));

import { useChatDebug } from './useChatDebug';

describe('useChatDebug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses scoped toggle when chatId is available', async () => {
    const chatDebug = useChatDebug({
      chatId: computed(() => 'chat-1'),
      debugEnabled: computed(() => true),
    });

    expect(chatDebug.enabled.value).toBe(true);
    await expect(chatDebug.toggle({})).resolves.toBeUndefined();

    expect(mockToggleDebugForChatId).toHaveBeenCalledWith({ chatId: 'chat-1' });
  });

  it('no-ops when chatId is undefined', async () => {
    const chatDebug = useChatDebug({
      chatId: computed(() => undefined),
      debugEnabled: computed(() => false),
    });

    expect(chatDebug.enabled.value).toBe(false);
    await expect(chatDebug.toggle({})).resolves.toBeUndefined();

    expect(mockToggleDebugForChatId).not.toHaveBeenCalled();
  });
});
