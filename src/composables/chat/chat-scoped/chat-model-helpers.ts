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
  getLiveChatById,
  rootItems,
  triggerCurrentChat,
} from '@/composables/chat/global/chat-core-singletons';

export async function fetchAvailableModelsForChat({
  chatId,
  errorSource,
}: {
  chatId: string;
  errorSource: string;
}): Promise<string[]> {
  const mutableChat = getLiveChatById({ chatId }) ?? undefined;
  if (mutableChat === undefined) {
    return [];
  }

  chatRuntimeStore.startTask({ key: { kind: 'fetch', chatId: mutableChat.id } });

  try {
    const { settings } = useSettings();
    const groups = collectChatGroups({ items: rootItems.value });
    const endpoint = resolveChatEndpointForChat({
      chat: mutableChat,
      chatGroups: groups,
      settings: settings.value,
    });

    const models = await fetchAvailableModelsForEndpoint({
      endpointType: endpoint.type,
      endpointUrl: endpoint.url,
      endpointHttpHeaders: endpoint.headers,
      errorSource,
    });

    if (currentChatRef.value !== null && toRaw(currentChatRef.value).id === mutableChat.id) {
      availableModels.value = models;
    }

    if (mutableChat !== undefined && mutableChat.modelId && !models.includes(mutableChat.modelId)) {
      mutableChat.modelId = '';
      mutableChat.updatedAt = Date.now();
      triggerCurrentChat({ chatId: mutableChat.id });
    }

    return models;
  } finally {
    chatRuntimeStore.finishTask({ key: { kind: 'fetch', chatId: mutableChat.id } });
  }
}

export async function fetchAvailableModelsForGlobalEndpoint({
  errorSource,
}: {
  errorSource: string;
}): Promise<string[]> {
  chatRuntimeStore.startTask({ key: { kind: 'fetch', chatId: undefined } });

  const { settings } = useSettings();
  try {
    const endpoint = resolveGlobalEndpoint({
      settings: settings.value,
    });

    const models = await fetchAvailableModelsForEndpoint({
      endpointType: endpoint.type,
      endpointUrl: endpoint.url,
      endpointHttpHeaders: endpoint.headers,
      errorSource,
    });

    availableModels.value = models;
    return models;
  } finally {
    chatRuntimeStore.finishTask({ key: { kind: 'fetch', chatId: undefined } });
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

export function resolveChatEndpointForChat({
  chat,
  chatGroups,
  settings,
}: {
  chat: {
    groupId?: string | null | undefined;
    endpointType?: EndpointType | undefined;
    endpointUrl?: string | undefined;
    endpointHttpHeaders?: readonly (readonly [string, string])[] | undefined;
  };
  chatGroups: readonly ChatGroup[];
  settings: {
    endpointType: EndpointType;
    endpointUrl?: string | undefined;
    endpointHttpHeaders?: readonly (readonly [string, string])[] | undefined;
  };
}): {
  type: EndpointType;
  url: string | undefined;
  headers: [string, string][] | undefined;
} {
  const group = chat.groupId ? chatGroups.find(({ id }) => id === chat.groupId) : undefined;
  return {
    type: chat.endpointType || group?.endpoint?.type || settings.endpointType,
    url: chat.endpointUrl || group?.endpoint?.url || settings.endpointUrl,
    headers: cloneHeaders({
      headers: chat.endpointHttpHeaders || group?.endpoint?.httpHeaders || settings.endpointHttpHeaders,
    }),
  };
}

export function resolveGlobalEndpoint({
  settings,
}: {
  settings: {
    endpointType: EndpointType;
    endpointUrl?: string | undefined;
    endpointHttpHeaders?: readonly (readonly [string, string])[] | undefined;
  };
}): {
  type: EndpointType;
  url: string | undefined;
  headers: [string, string][] | undefined;
} {
  return {
    type: settings.endpointType,
    url: settings.endpointUrl,
    headers: cloneHeaders({
      headers: settings.endpointHttpHeaders,
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
