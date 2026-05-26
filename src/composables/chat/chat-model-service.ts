import { toRaw, type Ref } from 'vue';
import type { Chat, ChatGroup, EndpointType, Settings } from '@/models/types';
import { OpenAIProvider } from '@/services/lm/openai';
import { OllamaProvider } from '@/services/lm/ollama';
import { TransformersJsProvider } from '@/services/transformers-js/provider';
import type { ChatRuntimeStore } from './chat-runtime-store';

export type ChatModelService = {
  fetchAvailableModels({
    chatId,
    customEndpoint,
  }: {
    chatId?: string;
    customEndpoint?: {
      type: EndpointType;
      url: string;
      headers?: readonly (readonly [string, string])[];
    };
  }): Promise<string[]>;
};

export function createChatModelService({
  currentChatRef,
  liveChatRegistry,
  availableModelsRef,
  getChatGroups,
  getSettings,
  triggerCurrentChat,
  runtimeStore,
  addErrorEvent,
}: {
  currentChatRef: Ref<Chat | null>;
  liveChatRegistry: Map<string, Chat>;
  availableModelsRef: Ref<string[]>;
  getChatGroups: () => ChatGroup[];
  getSettings: () => {
    endpointType: Settings['endpointType'];
    endpointUrl?: string | undefined;
    endpointHttpHeaders?: readonly (readonly [string, string])[] | undefined;
  };
  triggerCurrentChat: ({ chatId }: { chatId: string }) => void;
  runtimeStore: ChatRuntimeStore;
  addErrorEvent: ({
    source,
    message,
    details,
  }: {
    source: string;
    message: string;
    details: string;
  }) => void;
}): ChatModelService {
  async function fetchAvailableModels({
    chatId,
    customEndpoint,
  }: {
    chatId?: string;
    customEndpoint?: {
      type: EndpointType;
      url: string;
      headers?: readonly (readonly [string, string])[];
    };
  }) {
    const mutableChat = chatId ? liveChatRegistry.get(chatId) : undefined;
    if (mutableChat) {
      runtimeStore.startTask({ key: { kind: 'fetch', chatId: mutableChat.id } });
    } else if (!customEndpoint) {
      runtimeStore.startTask({ key: { kind: 'fetch', chatId: undefined } });
    }

    let type: EndpointType;
    let url: string;
    let headers: readonly (readonly [string, string])[] | undefined;

    if (customEndpoint) {
      type = customEndpoint.type;
      url = customEndpoint.url;
      headers = customEndpoint.headers;
    } else if (mutableChat) {
      const group = mutableChat.groupId ? getChatGroups().find(item => item.id === mutableChat.groupId) : null;
      const settings = getSettings();
      type = mutableChat.endpointType || group?.endpoint?.type || settings.endpointType;
      url = mutableChat.endpointUrl || group?.endpoint?.url || settings.endpointUrl || '';
      headers = mutableChat.endpointHttpHeaders || group?.endpoint?.httpHeaders || settings.endpointHttpHeaders;
    } else if (currentChatRef.value) {
      const chat = toRaw(currentChatRef.value);
      const group = chat.groupId ? getChatGroups().find(item => item.id === chat.groupId) : null;
      const settings = getSettings();
      type = chat.endpointType || group?.endpoint?.type || settings.endpointType;
      url = chat.endpointUrl || group?.endpoint?.url || settings.endpointUrl || '';
      headers = chat.endpointHttpHeaders || group?.endpoint?.httpHeaders || settings.endpointHttpHeaders;
    } else {
      const settings = getSettings();
      type = settings.endpointType;
      url = settings.endpointUrl || '';
      headers = settings.endpointHttpHeaders;
    }

    if (!url && type !== 'transformers_js') {
      finishFetchTask({
        runtimeStore,
        mutableChatId: mutableChat?.id,
        customEndpointProvided: customEndpoint !== undefined,
      });
      return [];
    }

    try {
      const mutableHeaders = headers ? JSON.parse(JSON.stringify(headers)) : undefined;
      const provider = (() => {
        switch (type) {
        case 'ollama':
          return new OllamaProvider({ endpoint: url, headers: mutableHeaders });
        case 'openai':
          return new OpenAIProvider({ endpoint: url, headers: mutableHeaders });
        case 'transformers_js':
          return new TransformersJsProvider();
        default: {
          const _ex: never = type;
          throw new Error(`Unhandled endpoint type: ${_ex}`);
        }
        }
      })();

      const models = await provider.listModels({});
      const result = Array.isArray(models) ? models : [];
      if ((mutableChat && currentChatRef.value && toRaw(currentChatRef.value).id === mutableChat.id) || (!mutableChat && !chatId)) {
        availableModelsRef.value = result;
      }

      if (mutableChat && mutableChat.modelId && !result.includes(mutableChat.modelId)) {
        mutableChat.modelId = '';
        mutableChat.updatedAt = Date.now();
        triggerCurrentChat({ chatId: mutableChat.id });
      }

      return result;
    } catch (error) {
      addErrorEvent({
        source: 'useChat:fetchAvailableModels',
        message: 'Failed to fetch models for resolution',
        details: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      finishFetchTask({
        runtimeStore,
        mutableChatId: mutableChat?.id,
        customEndpointProvided: customEndpoint !== undefined,
      });
    }
  }

  return {
    fetchAvailableModels,
  };
}

function finishFetchTask({
  runtimeStore,
  mutableChatId,
  customEndpointProvided,
}: {
  runtimeStore: ChatRuntimeStore;
  mutableChatId: string | undefined;
  customEndpointProvided: boolean;
}) {
  if (mutableChatId) {
    runtimeStore.finishTask({ key: { kind: 'fetch', chatId: mutableChatId } });
  } else if (!customEndpointProvided) {
    runtimeStore.finishTask({ key: { kind: 'fetch', chatId: undefined } });
  }
}
