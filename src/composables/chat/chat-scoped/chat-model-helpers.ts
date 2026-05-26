import { toRaw } from 'vue';
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
  getChatTargetByOptionalId,
  rootItems,
  triggerCurrentChat,
} from '@/composables/chat/global/chat-core-singletons';

export async function fetchAvailableModelsForChat({
  chatId,
}: {
  chatId: string | undefined;
}): Promise<string[]> {
  const mutableChat = getChatTargetByOptionalId({ chatId }) ?? undefined;
  if (mutableChat !== undefined) {
    chatRuntimeStore.startTask({ key: { kind: 'fetch', chatId: mutableChat.id } });
  } else if (chatId === undefined) {
    chatRuntimeStore.startTask({ key: { kind: 'fetch', chatId: undefined } });
  }

  try {
    const endpoint = resolveChatEndpoint({ chatId });
    if (endpoint === undefined) {
      return [];
    }

    const models = await fetchAvailableModelsForEndpoint({
      endpointType: endpoint.type,
      endpointUrl: endpoint.url,
      endpointHttpHeaders: endpoint.headers,
      errorSource: 'useChatModelSelection:fetchModels',
    });

    if ((mutableChat !== undefined && currentChatRef.value !== null && toRaw(currentChatRef.value).id === mutableChat.id) || chatId === undefined) {
      availableModels.value = models;
    }

    if (mutableChat !== undefined && mutableChat.modelId && !models.includes(mutableChat.modelId)) {
      mutableChat.modelId = '';
      mutableChat.updatedAt = Date.now();
      triggerCurrentChat({ chatId: mutableChat.id });
    }

    return models;
  } finally {
    if (mutableChat !== undefined) {
      chatRuntimeStore.finishTask({ key: { kind: 'fetch', chatId: mutableChat.id } });
    } else if (chatId === undefined) {
      chatRuntimeStore.finishTask({ key: { kind: 'fetch', chatId: undefined } });
    }
  }
}

export async function fetchAvailableModelsForEndpoint({
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

  const { addErrorEvent } = useGlobalEvents();

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

function resolveChatEndpoint({
  chatId,
}: {
  chatId: string | undefined;
}): {
  type: EndpointType;
  url: string | undefined;
  headers: [string, string][] | undefined;
} | undefined {
  const { settings } = useSettings();
  const mutableChat = getChatTargetByOptionalId({ chatId });

  if (mutableChat !== null) {
    const group = mutableChat.groupId ? collectChatGroups({ items: rootItems.value }).find(({ id }) => id === mutableChat.groupId) : undefined;
    return {
      type: mutableChat.endpointType || group?.endpoint?.type || settings.value.endpointType,
      url: mutableChat.endpointUrl || group?.endpoint?.url || settings.value.endpointUrl,
      headers: cloneHeaders({
        headers: mutableChat.endpointHttpHeaders || group?.endpoint?.httpHeaders || settings.value.endpointHttpHeaders,
      }),
    };
  }

  if (currentChatRef.value !== null) {
    const chat = toRaw(currentChatRef.value);
    const group = chat.groupId ? collectChatGroups({ items: rootItems.value }).find(({ id }) => id === chat.groupId) : undefined;
    return {
      type: chat.endpointType || group?.endpoint?.type || settings.value.endpointType,
      url: chat.endpointUrl || group?.endpoint?.url || settings.value.endpointUrl,
      headers: cloneHeaders({
        headers: chat.endpointHttpHeaders || group?.endpoint?.httpHeaders || settings.value.endpointHttpHeaders,
      }),
    };
  }

  return {
    type: settings.value.endpointType,
    url: settings.value.endpointUrl,
    headers: cloneHeaders({
      headers: settings.value.endpointHttpHeaders,
    }),
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

function cloneHeaders({
  headers,
}: {
  headers: readonly (readonly [string, string])[] | undefined;
}): [string, string][] | undefined {
  return headers ? headers.map(([name, value]) => [name, value]) : undefined;
}
