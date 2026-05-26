import { computed, type ComputedRef } from 'vue';
import type { ChatGroup, EndpointType, Mount } from '@/models/types';
import { useChat } from '@/composables/useChat';
import { useCurrentChatState } from './useCurrentChatState';

export type ChatGroupSettingsPanelAdapter = {
  currentChatGroup: ComputedRef<Readonly<ChatGroup> | null>;
  fetchingModels: ComputedRef<boolean>;

  updateMetadata({
    groupId,
    updates,
  }: {
    groupId: string;
    updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }): Promise<void>;

  fetchModels({
    endpointType,
    endpointUrl,
    endpointHttpHeaders,
  }: {
    endpointType: EndpointType;
    endpointUrl: string;
    endpointHttpHeaders: [string, string][] | undefined;
  }): Promise<string[]>;

  addMount({
    groupId,
    mount,
  }: {
    groupId: string;
    mount: Mount;
  }): Promise<void>;

  removeMount({
    groupId,
    volumeId,
  }: {
    groupId: string;
    volumeId: string;
  }): Promise<void>;

  updateMount({
    groupId,
    volumeId,
    mountPath,
    readOnly,
  }: {
    groupId: string;
    volumeId: string;
    mountPath: string;
    readOnly: boolean;
  }): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useChatGroupSettingsPanel(): ChatGroupSettingsPanelAdapter {
  const chatStore = useChat();
  const currentChatState = useCurrentChatState();

  const fetchingModels = computed(() => chatStore.fetchingModels.value);

  async function updateMetadata({
    groupId,
    updates,
  }: {
    groupId: string;
    updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    await chatStore.updateChatGroupMetadata({
      id: groupId,
      updates,
    });
  }

  async function fetchModels({
    endpointType,
    endpointUrl,
    endpointHttpHeaders,
  }: {
    endpointType: EndpointType;
    endpointUrl: string;
    endpointHttpHeaders: [string, string][] | undefined;
  }) {
    return await chatStore.fetchAvailableModels({
      chatId: undefined,
      customEndpoint: {
        type: endpointType,
        url: endpointUrl,
        headers: endpointHttpHeaders,
      },
    });
  }

  async function addMount({
    groupId,
    mount,
  }: {
    groupId: string;
    mount: Mount;
  }) {
    await chatStore.addMountToChatGroup({
      groupId,
      mount,
    });
  }

  async function removeMount({
    groupId,
    volumeId,
  }: {
    groupId: string;
    volumeId: string;
  }) {
    await chatStore.removeMountFromChatGroup({
      groupId,
      volumeId,
    });
  }

  async function updateMount({
    groupId,
    volumeId,
    mountPath,
    readOnly,
  }: {
    groupId: string;
    volumeId: string;
    mountPath: string;
    readOnly: boolean;
  }) {
    await chatStore.updateChatGroupMount({
      groupId,
      volumeId,
      mountPath,
      readOnly,
    });
  }

  return {
    currentChatGroup: currentChatState.currentChatGroup,
    fetchingModels,
    updateMetadata,
    fetchModels,
    addMount,
    removeMount,
    updateMount,
    TEST_ONLY: {},
  };
}
