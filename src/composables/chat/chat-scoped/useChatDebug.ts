import { computed, type ComputedRef, type Ref } from 'vue';
import { useChatMutationActions } from '@/composables/chat/ui/useChatMutationActions';

export type ChatDebugAdapter = {
  enabled: ComputedRef<boolean>;

  toggle(_args: Record<never, never>): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useChatDebug({
  chatId,
  debugEnabled,
}: {
  chatId: Ref<string | undefined>;
  debugEnabled: ComputedRef<boolean>;
}): ChatDebugAdapter {
  const chatMutationActions = useChatMutationActions();

  const enabled = computed(() => debugEnabled.value);

  async function toggle(_args: Record<never, never>): Promise<void> {
    const id = chatId.value;
    if (id !== undefined) {
      await chatMutationActions.toggleDebugForChat({
        chatId: id,
      });
      return;
    }

    await chatMutationActions.toggleDebug({});
  }

  return {
    enabled,
    toggle,
    TEST_ONLY: {},
  };
}
