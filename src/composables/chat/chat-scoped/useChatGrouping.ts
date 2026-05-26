import type { Ref } from 'vue';
import { useChat } from '@/composables/useChat';

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
  const chatStore = useChat();

  async function moveToGroup({
    groupId,
  }: {
    groupId: string | null;
  }): Promise<void> {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    await chatStore.moveChatToGroup({
      chatId: id,
      targetGroupId: groupId,
    });
  }

  return {
    moveToGroup,
    TEST_ONLY: {},
  };
}
