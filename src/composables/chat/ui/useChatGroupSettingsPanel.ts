import { computed, type ComputedRef } from 'vue';
import type { ChatGroup, EndpointType, Mount } from '@/models/types';
import { fetchingModels } from '@/composables/chat/global/chat-core-singletons';
import { useCurrentChatState } from './useCurrentChatState';
import { useChatUiServices } from './useChatUiServices';

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
  const { hierarchyService, modelService, mountService } = useChatUiServices({});

  const fetchingModelsState = computed(() => fetchingModels.value);

  async function updateMetadata({
    groupId,
    updates,
  }: {
    groupId: string;
    updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    await hierarchyService.updateChatGroupMetadata({
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
    return await modelService.fetchAvailableModels({
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
    await mountService.addMountToChatGroup({
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
    await mountService.removeMountFromChatGroup({
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
    await mountService.updateChatGroupMount({
      groupId,
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
