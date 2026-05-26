import { computed, type ComputedRef } from 'vue';
import type { ChatGroup, EndpointType, Mount } from '@/models/types';
import { useChatGroupMounts } from '@/composables/chat/chat-scoped/useChatGroupMounts';
import { fetchingModels } from '@/composables/chat/global/chat-core-singletons';
import { loadData } from '@/composables/chat/global/chat-core-singletons';
import { useCurrentChatState } from './useCurrentChatState';
import { fetchAvailableModelsForEndpoint } from '@/composables/chat/chat-scoped/chat-model-helpers';
import { storageService } from '@/services/storage';

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
  const currentChatState = useCurrentChatState();
  const chatGroupMounts = useChatGroupMounts({
    chatGroupId: computed(() => currentChatState.currentChatGroup.value?.id),
  });

  const fetchingModelsState = computed(() => fetchingModels.value);

  async function updateMetadata({
    groupId,
    updates,
  }: {
    groupId: string;
    updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    await storageService.updateChatGroup(groupId, (current) => {
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

  async function fetchModels({
    endpointType,
    endpointUrl,
    endpointHttpHeaders,
  }: {
    endpointType: EndpointType;
    endpointUrl: string;
    endpointHttpHeaders: [string, string][] | undefined;
  }) {
    return await fetchAvailableModelsForEndpoint({
      endpointType,
      endpointUrl,
      endpointHttpHeaders,
      errorSource: 'useChatGroupSettingsPanel:fetchModels',
    });
  }

  async function addMount({
    groupId,
    mount,
  }: {
    groupId: string;
    mount: Mount;
  }) {
    if (currentChatState.currentChatGroup.value?.id !== groupId) {
      return;
    }

    await chatGroupMounts.addMount({ mount });
  }

  async function removeMount({
    groupId,
    volumeId,
  }: {
    groupId: string;
    volumeId: string;
  }) {
    if (currentChatState.currentChatGroup.value?.id !== groupId) {
      return;
    }

    await chatGroupMounts.removeMount({ volumeId });
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
    if (currentChatState.currentChatGroup.value?.id !== groupId) {
      return;
    }

    await chatGroupMounts.updateMount({
      volumeId,
      mountPath,
      readOnly,
    });
  }

  return {
    currentChatGroup: currentChatState.currentChatGroup,
    fetchingModels: fetchingModelsState,
    updateMetadata,
    fetchModels,
    addMount,
    removeMount,
    updateMount,
    TEST_ONLY: {},
  };
}
