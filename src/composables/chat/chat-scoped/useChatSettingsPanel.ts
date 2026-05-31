import { computed, type ComputedRef, type Ref } from 'vue';
import type { Chat } from '@/models/types';
import { availableModels, fetchingModels } from '@/composables/chat/global/chat-core-singletons';
import { useChatReadModel } from './useChatReadModel';
import { fetchAvailableModelsForChat } from './chat-model-helpers';
import { updateChatSettingsById } from './chat-metadata-helpers';

export type ChatSettingsPanelAdapter = {
  currentChat: ComputedRef<Readonly<Chat> | null>;
  fetchingModels: ComputedRef<boolean>;
  availableModels: Ref<string[]>;
  resolvedSettings: ReturnType<typeof useChatReadModel>['resolvedSettings'];
  inheritedSettings: ReturnType<typeof useChatReadModel>['inheritedSettings'];

  updateSettings({
    chatId,
    updates,
  }: {
    chatId: string;
    updates: Partial<Pick<Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }): Promise<void>;

  fetchModels({
    chatId,
  }: {
    chatId: string;
  }): Promise<string[]>;

  TEST_ONLY: Record<string, never>;
};

export function useChatSettingsPanel({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatSettingsPanelAdapter {
  const chatReadModel = useChatReadModel({ chatId });

  const fetchingModelsState = computed(() => fetchingModels.value);

  async function updateSettings({
    chatId,
    updates,
  }: {
    chatId: string;
    updates: Partial<Pick<Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    await updateChatSettingsById({
      chatId,
      updates,
    });
  }

  async function fetchModels({
    chatId,
  }: {
    chatId: string;
  }) {
    return await fetchAvailableModelsForChat({
      chatId,
    });
  }

  return {
    currentChat: chatReadModel.currentChat,
    fetchingModels: fetchingModelsState,
    availableModels,
    resolvedSettings: chatReadModel.resolvedSettings,
    inheritedSettings: chatReadModel.inheritedSettings,
    updateSettings,
    fetchModels,
    TEST_ONLY: {},
  };
}
