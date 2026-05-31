import { computed, type ComputedRef } from 'vue';
import type { Chat, ChatGroup, EndpointType } from '@/models/types';
import { useImageGeneration } from '@/composables/useImageGeneration';
import type { ChatFlowItem } from '@/composables/useChatDisplayFlow';
import { useChatDisplayFlow } from '@/composables/useChatDisplayFlow';
import { availableModels, fetchingModels, isProcessing, loadData } from '@/composables/chat/global/chat-core-singletons';
import { useCurrentChatState } from './useCurrentChatState';
import {
  fetchAvailableModelsForChat,
  fetchAvailableModelsForEndpoint,
  fetchAvailableModelsForGlobalEndpoint,
} from '@/composables/chat/chat-scoped/chat-model-helpers';
import { updateChatSettingsById } from '@/composables/chat/chat-scoped/chat-metadata-helpers';
import { storageService } from '@/services/storage';

type FetchAvailableModelsCustomEndpoint = {
  type: EndpointType;
  url: string;
  headers: [string, string][] | undefined;
};

export type ChatAreaDataAdapter = {
  availableModels: ComputedRef<string[]>;
  fetchingModels: ComputedRef<boolean>;
  chatFlow: ComputedRef<ChatFlowItem[]>;
  availableChatGroups: ComputedRef<ChatGroup[]>;

  getSortedImageModels({
    availableModels,
  }: {
    availableModels: string[];
  }): string[];

  fetchAvailableModels({
    chatId,
    customEndpoint,
  }: {
    chatId: string | undefined;
    customEndpoint: FetchAvailableModelsCustomEndpoint | undefined;
  }): Promise<string[]>;

  isThinkingActive({
    item,
  }: {
    item: ChatFlowItem;
  }): boolean;

  isWaitingResponse({
    item,
  }: {
    item: ChatFlowItem;
  }): boolean;

  updateChatSettings({
    id,
    updates,
  }: {
    id: string;
    updates: Partial<Pick<Chat, 'titleModelId'>>;
  }): Promise<void>;

  updateChatGroupMetadata({
    id,
    updates,
  }: {
    id: string;
    updates: Partial<Pick<ChatGroup, 'titleModelId'>>;
  }): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useChatAreaData(): ChatAreaDataAdapter {
  const currentChatState = useCurrentChatState();
  const { getSortedImageModels: getSortedImageModelsImpl } = useImageGeneration();
  const {
    chatFlow,
    isThinkingActive: isThinkingActiveImpl,
    isWaitingResponse: isWaitingResponseImpl,
  } = useChatDisplayFlow({
    chat: currentChatState.currentChat as ComputedRef<Chat | null>,
    isProcessing,
  });

  const availableModelsState = computed(() => availableModels.value);
  const fetchingModelsState = computed(() => fetchingModels.value);
  const chatFlowState = computed(() => chatFlow.value);
  const availableChatGroups = computed(() => currentChatState.chatGroups.value);

  function getSortedImageModels({
    availableModels,
  }: {
    availableModels: string[];
  }) {
    return getSortedImageModelsImpl({
      availableModels,
    });
  }

  async function fetchAvailableModels({
    chatId,
    customEndpoint,
  }: {
    chatId: string | undefined;
    customEndpoint: FetchAvailableModelsCustomEndpoint | undefined;
  }) {
    if (customEndpoint !== undefined) {
      return await fetchAvailableModelsForEndpoint({
        endpointType: customEndpoint.type,
        endpointUrl: customEndpoint.url,
        endpointHttpHeaders: customEndpoint.headers,
        errorSource: 'useChatAreaData:fetchAvailableModels',
      });
    }

    if (chatId === undefined) {
      return await fetchAvailableModelsForGlobalEndpoint({
        errorSource: 'useChatAreaData:fetchAvailableModels:global',
      });
    }

    return await fetchAvailableModelsForChat({
      chatId,
      errorSource: 'useChatAreaData:fetchAvailableModels',
    });
  }

  function isThinkingActive({
    item,
  }: {
    item: ChatFlowItem;
  }) {
    return isThinkingActiveImpl({
      item,
    });
  }

  function isWaitingResponse({
    item,
  }: {
    item: ChatFlowItem;
  }) {
    return isWaitingResponseImpl({
      item,
    });
  }

  async function updateChatSettings({
    id,
    updates,
  }: {
    id: string;
    updates: Partial<Pick<Chat, 'titleModelId'>>;
  }) {
    await updateChatSettingsById({
      chatId: id,
      updates,
    });
  }

  async function updateChatGroupMetadata({
    id,
    updates,
  }: {
    id: string;
    updates: Partial<Pick<ChatGroup, 'titleModelId'>>;
  }) {
    await storageService.updateChatGroup(id, (current) => {
      if (current === null) {
        throw new Error('Chat group not found');
      }

      return {
        ...current,
        ...updates,
        updatedAt: Date.now(),
      };
    });
    await loadData({});
  }

  return {
    availableModels: availableModelsState,
    fetchingModels: fetchingModelsState,
    chatFlow: chatFlowState,
    availableChatGroups,
    getSortedImageModels,
    fetchAvailableModels,
    isThinkingActive,
    isWaitingResponse,
    updateChatSettings,
    updateChatGroupMetadata,
    TEST_ONLY: {},
  };
}
