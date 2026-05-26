import { computed, type ComputedRef, type Ref } from 'vue';
import { useChat } from '@/composables/useChat';

export type ChatDebugAdapter = {
  enabled: ComputedRef<boolean>;

  toggle(_args: Record<never, never>): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

type ChatDebugStoreCompatibility = ReturnType<typeof useChat> & {
  toggleDebugForChat?: ({
    chatId,
  }: {
    chatId: string;
  }) => Promise<void>;
};

export function useChatDebug({
  chatId,
  debugEnabled,
}: {
  chatId: Ref<string | undefined>;
  debugEnabled: ComputedRef<boolean>;
}): ChatDebugAdapter {
  const chatStore = useChat() as ChatDebugStoreCompatibility;

  const enabled = computed(() => debugEnabled.value);

  async function toggle(_args: Record<never, never>): Promise<void> {
    const id = chatId.value;
    if (id !== undefined && typeof chatStore.toggleDebugForChat === 'function') {
      await chatStore.toggleDebugForChat({
        chatId: id,
      });
      return;
    }

    await chatStore.toggleDebug({});
  }

  return {
    enabled,
    toggle,
    TEST_ONLY: {},
  };
}
