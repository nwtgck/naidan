import { computed, type ComputedRef, type Ref } from 'vue';
import type { EndpointType } from '@/models/types';
import type { ChatId } from '@/models/ids';
import {
  availableModels,
  fetchingModels,
} from '@/composables/chat/global/chat-core-singletons';
import {
  fetchModelsForChat,
  fetchModelsForEndpoint,
  fetchModelsForGlobalEndpoint,
} from '@/composables/chat/chat-model-fetch';

type FetchAvailableModelsCustomEndpoint = {
  type: EndpointType,
  url: string,
  headers: [string, string][] | undefined,
};

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
    customEndpoint,
  }: {
    customEndpoint: FetchAvailableModelsCustomEndpoint,
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
    customEndpoint,
  }: {
    customEndpoint: FetchAvailableModelsCustomEndpoint,
  }): Promise<string[]> {
    return await fetchModelsForEndpoint({
      endpointType: customEndpoint.type,
      endpointUrl: customEndpoint.url,
      endpointHttpHeaders: customEndpoint.headers,
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
