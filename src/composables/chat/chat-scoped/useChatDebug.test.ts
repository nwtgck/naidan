import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockToggleDebug,
  mockToggleDebugForChat,
} = vi.hoisted(() => ({
  mockToggleDebug: vi.fn(),
  mockToggleDebugForChat: vi.fn(),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    toggleDebug: mockToggleDebug,
    toggleDebugForChat: mockToggleDebugForChat,
  }),
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

    expect(mockToggleDebugForChat).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(mockToggleDebug).not.toHaveBeenCalled();
  });

  it('falls back to compat toggle when chatId is undefined', async () => {
    const chatDebug = useChatDebug({
      chatId: computed(() => undefined),
      debugEnabled: computed(() => false),
    });

    expect(chatDebug.enabled.value).toBe(false);
    await expect(chatDebug.toggle({})).resolves.toBeUndefined();

    expect(mockToggleDebug).toHaveBeenCalledWith({});
    expect(mockToggleDebugForChat).not.toHaveBeenCalled();
  });
});
