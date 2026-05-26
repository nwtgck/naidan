import { computed, type ComputedRef } from 'vue';
import type { Chat } from '@/models/types';
import { useChat } from '@/composables/useChat';
import { useCurrentChatState } from './useCurrentChatState';

export type ChatSettingsPanelAdapter = {
  currentChat: ComputedRef<Readonly<Chat> | null>;
  currentChatId: ComputedRef<string | undefined>;
  fetchingModels: ComputedRef<boolean>;
  availableModels: ReturnType<typeof useChat>['availableModels'];
  resolvedSettings: ReturnType<typeof useCurrentChatState>['resolvedSettings'];
  inheritedSettings: ReturnType<typeof useCurrentChatState>['inheritedSettings'];

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

export function useChatSettingsPanel(): ChatSettingsPanelAdapter {
  const chatStore = useChat();
  const currentChatState = useCurrentChatState();

  const fetchingModels = computed(() => chatStore.fetchingModels.value);

  async function updateSettings({
    chatId,
    updates,
  }: {
    chatId: string;
    updates: Partial<Pick<Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    await chatStore.updateChatSettings({
      id: chatId,
      updates,
    });
  }

  async function fetchModels({
    chatId,
  }: {
    chatId: string;
  }) {
    return await chatStore.fetchAvailableModels({
      chatId,
    });
  }

  return {
    currentChat: currentChatState.currentChat,
    currentChatId: currentChatState.currentChatId,
    fetchingModels,
    availableModels: chatStore.availableModels,
    resolvedSettings: currentChatState.resolvedSettings,
    inheritedSettings: currentChatState.inheritedSettings,
    updateSettings,
    fetchModels,
    TEST_ONLY: {},
  };
}
