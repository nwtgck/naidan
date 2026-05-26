import { computed, type ComputedRef, type Ref } from 'vue';
import { useChatMutationActions } from '@/composables/chat/ui/useChatMutationActions';

export type ChatModelSelectionAdapter = {
  availableModels: Ref<string[]>;
  fetchingModels: ComputedRef<boolean>;

  fetchModels(_args: Record<never, never>): Promise<string[]>;

  updateModel({
    modelId,
  }: {
    modelId: string | undefined;
  }): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useChatModelSelection({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatModelSelectionAdapter {
  const chatMutationActions = useChatMutationActions();
  const fetchingModels = computed(() => chatMutationActions.fetchingModels.value);

  async function fetchModels(_args: Record<never, never>): Promise<string[]> {
    return await chatMutationActions.fetchAvailableModels({
      chatId: chatId.value,
    });
  }

  async function updateModel({
    modelId,
  }: {
    modelId: string | undefined;
  }) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    await chatMutationActions.updateChatModel({
      id,
      modelId,
    });
  }

  return {
    availableModels: chatMutationActions.availableModels,
    fetchingModels,
    fetchModels,
    updateModel,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
