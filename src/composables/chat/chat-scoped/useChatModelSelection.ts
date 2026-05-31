import { computed, type ComputedRef, type Ref } from 'vue';
import { availableModels, fetchingModels } from '@/composables/chat/global/chat-core-singletons';
import { fetchAvailableModelsForChat } from './chat-model-helpers';
import { updateChatModelById } from './chat-metadata-helpers';

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
  const fetchingModelsState = computed(() => fetchingModels.value);

  async function fetchModels(_args: Record<never, never>): Promise<string[]> {
    const id = chatId.value;
    if (id === undefined) {
      return [];
    }

    return await fetchAvailableModelsForChat({
      chatId: id,
      errorSource: 'useChatModelSelection:fetchModels',
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

    await updateChatModelById({
      chatId: id,
      modelId,
    });
  }

  return {
    availableModels,
    fetchingModels: fetchingModelsState,
    fetchModels,
    updateModel,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
