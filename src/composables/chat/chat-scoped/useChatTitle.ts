import { computed, type ComputedRef, type Ref } from 'vue';
import { useChatMutationActions } from '@/composables/chat/ui/useChatMutationActions';

export type ChatTitleAdapter = {
  isGenerating: ComputedRef<boolean>;

  rename({
    title,
  }: {
    title: string;
  }): Promise<void>;

  generateTitle({
    titleModelIdOverride,
  }: {
    titleModelIdOverride: string | undefined;
  }): Promise<string | null | undefined>;

  abort(_args: Record<never, never>): void;

  TEST_ONLY: Record<string, never>;
};

export function useChatTitle({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatTitleAdapter {
  const chatMutationActions = useChatMutationActions();

  const isGenerating = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return false;
    }

    return chatMutationActions.isGeneratingTitle({ chatId: id });
  });

  async function rename({
    title,
  }: {
    title: string;
  }): Promise<void> {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    await chatMutationActions.renameChat({
      id,
      newTitle: title,
    });
  }

  async function generateTitle({
    titleModelIdOverride,
  }: {
    titleModelIdOverride: string | undefined;
  }): Promise<string | null | undefined> {
    const id = chatId.value;
    if (id === undefined) {
      return undefined;
    }

    return await chatMutationActions.generateChatTitle({
      chatId: id,
      titleModelIdOverride,
    });
  }

  function abort(_args: Record<never, never>) {
    chatMutationActions.abortTitleGeneration({
      chatId: chatId.value,
    });
  }

  return {
    isGenerating,
    rename,
    generateTitle,
    abort,
    TEST_ONLY: {},
  };
}
