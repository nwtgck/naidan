import { computed, type ComputedRef, type Ref } from 'vue';
import { useChat } from '@/composables/useChat';

export type ChatModelSelectionAdapter = {
  availableModels: Ref<string[]>;
  fetchingModels: ComputedRef<boolean>;

  fetchModels(_args: Record<never, never>): Promise<string[]>;

  updateModel({
    modelId,
  }: {
    modelId: string | undefined;
  }): Promise<void>;
};

type ChatModelSelectionStoreCompatibility = {
  availableModels: Ref<string[]>;
  fetchingModels: ComputedRef<boolean>;
  fetchAvailableModels: ({
    chatId,
  }: {
    chatId: string | undefined;
  }) => Promise<string[]>;
  updateChatModel: ({
    id,
    modelId,
  }: {
    id: string;
    modelId: string | undefined;
  }) => Promise<void>;
};

export function useChatModelSelection({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatModelSelectionAdapter {
  const chatStore = useChat() as ChatModelSelectionStoreCompatibility;

  const fetchingModels = computed(() => chatStore.fetchingModels.value);

  async function fetchModels(_args: Record<never, never>): Promise<string[]> {
    return await chatStore.fetchAvailableModels({
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

    await chatStore.updateChatModel({
      id,
      modelId,
    });
  }

  return {
    availableModels: chatStore.availableModels,
    fetchingModels,
    fetchModels,
    updateModel,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
