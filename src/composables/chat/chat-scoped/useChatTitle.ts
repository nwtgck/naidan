import { computed, type ComputedRef, type Ref } from 'vue';
import { useChat } from '@/composables/useChat';

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

type ChatTitleStoreCompatibility = ReturnType<typeof useChat> & {
  generatingTitle?: {
    value: boolean;
  };
  isGeneratingTitle?: ({
    chatId,
  }: {
    chatId: string;
  }) => boolean;
};

export function useChatTitle({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatTitleAdapter {
  const chatStore = useChat() as ChatTitleStoreCompatibility;

  const isGenerating = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return false;
    }

    if (typeof chatStore.isGeneratingTitle === 'function') {
      return chatStore.isGeneratingTitle({ chatId: id });
    }

    return chatStore.generatingTitle?.value ?? false;
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

    await chatStore.renameChat({
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

    return await chatStore.generateChatTitle({
      chatId: id,
      signal: undefined,
      titleModelIdOverride,
    });
  }

  function abort(_args: Record<never, never>) {
    chatStore.abortTitleGeneration({
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
