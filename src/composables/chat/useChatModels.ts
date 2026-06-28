import { computed, type ComputedRef, type Ref } from 'vue';
import type { Endpoint } from '@/01-models/types';
import type { ChatId } from '@/01-models/ids';
import {
  availableModels,
  fetchingModels,
} from '@/composables/chat/global/chat-core-singletons';
import {
  fetchModelsForChat,
  fetchModelsForEndpoint,
  fetchModelsForGlobalEndpoint,
} from '@/composables/chat/chat-model-fetch';

export type ChatModelsAdapter = {
  availableModels: Ref<string[]>,
  fetchingModels: ComputedRef<boolean>,

  fetchForChat({
    chatId,
  }: {
    chatId: ChatId,
  }): Promise<string[]>,

  fetchForGlobalEndpoint(): Promise<string[]>,

  fetchForEndpoint({
    endpoint,
  }: {
    endpoint: Endpoint,
  }): Promise<string[]>,

  TEST_ONLY: Record<never, never>,
};

export function useChatModels(): ChatModelsAdapter {
  const fetchingModelsState = computed(() => fetchingModels.value);

  async function fetchForChat({
    chatId,
  }: {
    chatId: ChatId,
  }): Promise<string[]> {
    return await fetchModelsForChat({
      chatId,
      errorSource: 'useChatModels:fetchForChat',
    });
  }

  async function fetchForGlobalEndpoint(): Promise<string[]> {
    return await fetchModelsForGlobalEndpoint({
      errorSource: 'useChatModels:fetchForGlobalEndpoint',
    });
  }

  async function fetchForEndpoint({
    endpoint,
  }: {
    endpoint: Endpoint,
  }): Promise<string[]> {
    return await fetchModelsForEndpoint({
      endpoint,
      errorSource: 'useChatModels:fetchForEndpoint',
    });
  }

  return {
    availableModels,
    fetchingModels: fetchingModelsState,
    fetchForChat,
    fetchForGlobalEndpoint,
    fetchForEndpoint,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
