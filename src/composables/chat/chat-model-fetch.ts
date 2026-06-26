import { toRaw } from 'vue';
import { ensureStrings } from '@/strings';
import type { ChatGroup, EndpointType } from '@/models/types';
import type { LmProvider } from '@/services/lm/types';
import { createLmProvider } from '@/services/lm/providerFactory';
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
import type { ChatId } from '@/models/ids';
import {
  resolveChatEndpointForChat,
  resolveGlobalEndpoint,
} from '@/composables/chat/chat-model-helpers';

export async function fetchModelsForChat({
  chatId,
  errorSource,
}: {
  chatId: ChatId,
  errorSource: string,
}): Promise<string[]> {
  const { settings } = useSettings();
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
    const models = await fetchModelsForEndpoint({
      endpointType: endpoint.type,
      endpointUrl: endpoint.url,
      endpointHttpHeaders: endpoint.headers,
      errorSource,
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

export async function fetchModelsForGlobalEndpoint({
  errorSource,
}: {
  errorSource: string,
}): Promise<string[]> {
  const { settings } = useSettings();
  chatRuntimeStore.startTask({ key: { kind: 'fetch', chatId: undefined } });
  try {
    const endpoint = resolveGlobalEndpoint({
      settings: settings.value,
    });
    const models = await fetchModelsForEndpoint({
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

export async function fetchModelsForEndpoint({
  endpointType,
  endpointUrl,
  endpointHttpHeaders,
  errorSource,
}: {
  endpointType: EndpointType,
  endpointUrl: string | undefined,
  endpointHttpHeaders: [string, string][] | undefined,
  errorSource: string,
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
      message: await ensureStrings.chatModelFetch__failed_to_fetch_models_for_resolution(),
      details: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function collectChatGroups({
  items,
}: {
  items: typeof rootItems.value,
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
  endpointType: EndpointType,
  endpointUrl: string | undefined,
  endpointHttpHeaders: [string, string][] | undefined,
}): LmProvider {
  const { settings } = useSettings();
  return createLmProvider({
    endpointType,
    endpointUrl,
    endpointHttpHeaders,
    fakeLmDebugModeStatus: settings.value.experimental?.fakeLm ?? 'disabled',
  });
}
