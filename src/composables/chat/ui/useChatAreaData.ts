import { computed, type ComputedRef } from 'vue';
import type { Chat, ChatGroup, EndpointType } from '@/models/types';
import type { ChatFlowItem } from '@/composables/useChatDisplayFlow';
import { useChat } from '@/composables/useChat';

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
  const chatStore = useChat();

  const availableModels = computed(() => chatStore.availableModels.value);
  const fetchingModels = computed(() => chatStore.fetchingModels.value);
  const chatFlow = computed(() => chatStore.chatFlow.value);
  const availableChatGroups = computed(() => chatStore.chatGroups?.value ?? []);

  function getSortedImageModels({
    availableModels,
  }: {
    availableModels: string[];
  }) {
    return chatStore.getSortedImageModels({
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
    return await chatStore.fetchAvailableModels({
      chatId,
      customEndpoint,
    });
  }

  function isThinkingActive({
    item,
  }: {
    item: ChatFlowItem;
  }) {
    return chatStore.isThinkingActive({
      item,
    });
  }

  function isWaitingResponse({
    item,
  }: {
    item: ChatFlowItem;
  }) {
    return chatStore.isWaitingResponse({
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
    await chatStore.updateChatSettings({
      id,
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
    await chatStore.updateChatGroupMetadata({
      id,
      updates,
    });
  }

  return {
    availableModels,
    fetchingModels,
    chatFlow,
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
