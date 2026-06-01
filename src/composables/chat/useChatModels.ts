import { computed, type ComputedRef, type Ref, toRaw } from 'vue';
import type { ChatGroup, EndpointType } from '@/models/types';
import type { LLMProvider } from '@/services/lm/types';
import { OpenAIProvider } from '@/services/lm/openai';
import { OllamaProvider } from '@/services/lm/ollama';
import { TransformersJsProvider } from '@/services/transformers-js/provider';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { useSettings } from '@/composables/useSettings';
import {
  availableModels,
  chatRuntimeStore,
  currentChatRef,
  getLiveChatById,
  rootItems,
  triggerCurrentChat,
  fetchingModels,
} from '@/composables/chat/global/chat-core-singletons';
import {
  resolveChatEndpointForChat,
  resolveGlobalEndpoint,
} from '@/composables/chat/chat-model-helpers';

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
  const { settings } = useSettings();
  const { addErrorEvent } = useGlobalEvents();

  async function fetchForChat({
    chatId,
  }: {
    chatId: string;
  }): Promise<string[]> {
    const mutableChat = getLiveChatById({ chatId });
    if (mutableChat === null) {
      return [];
    }

    chatRuntimeStore.startTask({ key: { kind: 'fetch', chatId: mutableChat.id } });
    try {
      const endpoint = resolveChatEndpointForChat({
        chat: mutableChat,
        chatGroups: collectChatGroups({ items: rootItems.value }),
        settings: settings.value,
      });
      const models = await fetchForResolvedEndpoint({
        endpointType: endpoint.type,
        endpointUrl: endpoint.url,
        endpointHttpHeaders: endpoint.headers,
        errorSource: 'useChatModels:fetchForChat',
      });

      if (currentChatRef.value !== null && toRaw(currentChatRef.value).id === mutableChat.id) {
        availableModels.value = models;
      }

      if (mutableChat.modelId && !models.includes(mutableChat.modelId)) {
        mutableChat.modelId = '';
        mutableChat.updatedAt = Date.now();
        triggerCurrentChat({ chatId: mutableChat.id });
      }

      return models;
    } finally {
      chatRuntimeStore.finishTask({ key: { kind: 'fetch', chatId: mutableChat.id } });
    }
  }

  async function fetchForGlobalEndpoint(_args: Record<never, never>): Promise<string[]> {
    chatRuntimeStore.startTask({ key: { kind: 'fetch', chatId: undefined } });
    try {
      const endpoint = resolveGlobalEndpoint({
        settings: settings.value,
      });
      const models = await fetchForResolvedEndpoint({
        endpointType: endpoint.type,
        endpointUrl: endpoint.url,
        endpointHttpHeaders: endpoint.headers,
        errorSource: 'useChatModels:fetchForGlobalEndpoint',
      });
      availableModels.value = models;
      return models;
    } finally {
      chatRuntimeStore.finishTask({ key: { kind: 'fetch', chatId: undefined } });
    }
  }

  async function fetchForEndpoint({
    customEndpoint,
  }: {
    customEndpoint: FetchAvailableModelsCustomEndpoint;
  }): Promise<string[]> {
    return await fetchForResolvedEndpoint({
      endpointType: customEndpoint.type,
      endpointUrl: customEndpoint.url,
      endpointHttpHeaders: customEndpoint.headers,
      errorSource: 'useChatModels:fetchForEndpoint',
    });
  }

  async function fetchForResolvedEndpoint({
    endpointType,
    endpointUrl,
    endpointHttpHeaders,
    errorSource,
  }: {
    endpointType: EndpointType;
    endpointUrl: string | undefined;
    endpointHttpHeaders: [string, string][] | undefined;
    errorSource: string;
  }): Promise<string[]> {
    if (!endpointUrl && endpointType !== 'transformers_js') {
      return [];
    }

    try {
      const provider = createProviderForEndpoint({
        endpointType,
        endpointUrl,
        endpointHttpHeaders,
      });
      const models = await provider.listModels({});
      return Array.isArray(models) ? models : [];
    } catch (error) {
      addErrorEvent({
        source: errorSource,
        message: 'Failed to fetch models for resolution',
        details: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
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

function collectChatGroups({
  items,
}: {
  items: typeof rootItems.value;
}): ChatGroup[] {
  return items.flatMap((item) => {
    switch (item.type) {
    case 'chat':
      return [];
    case 'chat_group':
      return [item.chatGroup];
    default: {
      const _ex: never = item;
      throw new Error(`Unhandled sidebar item type: ${_ex}`);
    }
    }
  });
}

function createProviderForEndpoint({
  endpointType,
  endpointUrl,
  endpointHttpHeaders,
}: {
  endpointType: EndpointType;
  endpointUrl: string | undefined;
  endpointHttpHeaders: [string, string][] | undefined;
}): LLMProvider {
  const headers = endpointHttpHeaders ? JSON.parse(JSON.stringify(endpointHttpHeaders)) as [string, string][] : undefined;

  switch (endpointType) {
  case 'openai':
    return new OpenAIProvider({ endpoint: endpointUrl || '', headers });
  case 'ollama':
    return new OllamaProvider({ endpoint: endpointUrl || '', headers });
  case 'transformers_js':
    return new TransformersJsProvider();
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
}
