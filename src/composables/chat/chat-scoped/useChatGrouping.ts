import type { Ref } from 'vue';
import { useChatOrganization } from '@/composables/chat/ui/useChatOrganization';

export type ChatGroupingAdapter = {
  moveToGroup({
    groupId,
  }: {
    groupId: string | null;
  }): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useChatGrouping({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatGroupingAdapter {
  const chatOrganization = useChatOrganization();

  async function moveToGroup({
    groupId,
  }: {
    groupId: string | null;
  }): Promise<void> {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    await chatOrganization.moveChatToGroup({
      chatId: id,
      targetGroupId: groupId,
    });
  }

  return {
    moveToGroup,
    TEST_ONLY: {},
  };
}
