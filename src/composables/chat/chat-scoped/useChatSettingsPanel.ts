import { computed, type ComputedRef, type Ref } from 'vue';
import type { Chat } from '@/models/types';
import { useChatMutationActions } from '@/composables/chat/ui/useChatMutationActions';
import { useChatReadModel } from './useChatReadModel';

export type ChatSettingsPanelAdapter = {
  currentChat: ComputedRef<Readonly<Chat> | null>;
  fetchingModels: ComputedRef<boolean>;
  availableModels: ReturnType<typeof useChatMutationActions>['availableModels'];
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
  const chatMutationActions = useChatMutationActions();
  const chatReadModel = useChatReadModel({ chatId });

  const fetchingModels = computed(() => chatMutationActions.fetchingModels.value);

  async function updateSettings({
    chatId,
    updates,
  }: {
    chatId: string;
    updates: Partial<Pick<Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    await chatMutationActions.updateChatSettings({
      id: chatId,
      updates,
    });
  }

  async function fetchModels({
    chatId,
  }: {
    chatId: string;
  }) {
    return await chatMutationActions.fetchAvailableModels({
      chatId,
    });
  }

  return {
    currentChat: chatReadModel.currentChat,
    fetchingModels,
    availableModels: chatMutationActions.availableModels,
    resolvedSettings: chatReadModel.resolvedSettings,
    inheritedSettings: chatReadModel.inheritedSettings,
    updateSettings,
    fetchModels,
    TEST_ONLY: {},
  };
}
