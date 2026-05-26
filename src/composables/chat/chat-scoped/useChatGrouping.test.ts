import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMoveChatToGroup } = vi.hoisted(() => ({
  mockMoveChatToGroup: vi.fn(),
}));

vi.mock('@/composables/chat/ui/useChatOrganization', () => ({
  useChatOrganization: () => ({
    moveChatToGroup: mockMoveChatToGroup,
    TEST_ONLY: {},
  }),
}));

import { useChatGrouping } from './useChatGrouping';

describe('useChatGrouping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops when chatId is undefined', async () => {
    const chatGrouping = useChatGrouping({
      chatId: computed(() => undefined),
    });

    await expect(chatGrouping.moveToGroup({ groupId: 'group-1' })).resolves.toBeUndefined();
    expect(mockMoveChatToGroup).not.toHaveBeenCalled();
  });

  it('binds moveToGroup to the scoped chatId', async () => {
    const chatGrouping = useChatGrouping({
      chatId: computed(() => 'chat-1'),
    });

    await expect(chatGrouping.moveToGroup({ groupId: 'group-1' })).resolves.toBeUndefined();
    expect(mockMoveChatToGroup).toHaveBeenCalledWith({
      chatId: 'chat-1',
      targetGroupId: 'group-1',
    });
  });
});
