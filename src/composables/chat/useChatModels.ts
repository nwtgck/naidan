import { computed, type ComputedRef, type Ref } from 'vue';
import type { EndpointType } from '@/models/types';
import { availableModels, fetchingModels } from '@/composables/chat/global/chat-core-singletons';
import {
  fetchAvailableModelsForChat,
  fetchAvailableModelsForEndpoint,
  fetchAvailableModelsForGlobalEndpoint,
} from '@/composables/chat/chat-scoped/chat-model-helpers';

type FetchAvailableModelsCustomEndpoint = {
  type: EndpointType;
  url: string;
  headers: [string, string][] | undefined;
};

export type ChatModelsAdapter = {
  availableModels: Ref<string[]>;
  fetchingModels: ComputedRef<boolean>;

  fetchForChat({
    chatId,
  }: {
    chatId: string;
  }): Promise<string[]>;

  fetchForGlobalEndpoint(_args: Record<never, never>): Promise<string[]>;

  fetchForEndpoint({
    customEndpoint,
  }: {
    customEndpoint: FetchAvailableModelsCustomEndpoint;
  }): Promise<string[]>;

  TEST_ONLY: Record<never, never>;
};

export function useChatModels(_args: Record<never, never>): ChatModelsAdapter {
  const fetchingModelsState = computed(() => fetchingModels.value);

  async function fetchForChat({
    chatId,
  }: {
    chatId: string;
  }): Promise<string[]> {
    return await fetchAvailableModelsForChat({
      chatId,
      errorSource: 'useChatModels:fetchForChat',
    });
  }

  async function fetchForGlobalEndpoint(_args: Record<never, never>): Promise<string[]> {
    return await fetchAvailableModelsForGlobalEndpoint({
      errorSource: 'useChatModels:fetchForGlobalEndpoint',
    });
  }

  async function fetchForEndpoint({
    customEndpoint,
  }: {
    customEndpoint: FetchAvailableModelsCustomEndpoint;
  }): Promise<string[]> {
    return await fetchAvailableModelsForEndpoint({
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
