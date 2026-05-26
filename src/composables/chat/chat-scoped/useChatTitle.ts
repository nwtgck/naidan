import { computed, type ComputedRef, type Ref } from 'vue';
import {
  abortTitleGenerationForChat,
  generateChatTitleForChat,
  isGeneratingChatTitle,
} from './chat-title-helpers';
import { renameChatById } from './chat-metadata-helpers';

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
  const isGenerating = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return false;
    }

    return isGeneratingChatTitle({ chatId: id });
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

    await renameChatById({
      chatId: id,
      title,
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

    return await generateChatTitleForChat({
      chatId: id,
      titleModelIdOverride,
      signal: undefined,
    });
  }

  function abort(_args: Record<never, never>) {
    abortTitleGenerationForChat({
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
