import type { Ref } from 'vue';
import { useChatMutationActions } from '@/composables/chat/ui/useChatMutationActions';

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
  const chatMutationActions = useChatMutationActions();

  async function moveToGroup({
    groupId,
  }: {
    groupId: string | null;
  }): Promise<void> {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    await chatMutationActions.moveChatToGroup({
      chatId: id,
      targetGroupId: groupId,
    });
  }

  return {
    moveToGroup,
    TEST_ONLY: {},
  };
}
