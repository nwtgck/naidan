import { computed, type ComputedRef } from 'vue';
import type { Chat } from '@/models/types';
import type { HistoryItem } from '@/utils/chat-tree';
import type { SystemPrompt } from '@/models/types';
import {
  availableModels,
  fetchingModels,
} from '@/composables/chat/global/chat-core-singletons';
import {
  abortTitleGenerationForChat,
  generateChatTitleForChat,
  isGeneratingChatTitle,
} from '@/composables/chat/chat-scoped/chat-title-helpers';
import {
  commitFullHistoryManipulationForChat,
} from '@/composables/chat/chat-scoped/chat-history-flow';
import {
  renameChatById,
  toggleDebugForChatId,
  updateChatModelById,
  updateChatSettingsById,
} from '@/composables/chat/chat-scoped/chat-metadata-helpers';
import { fetchAvailableModelsForChat } from '@/composables/chat/chat-scoped/chat-model-helpers';
import { useChatUiServices } from './useChatUiServices';
import { useChatOrganization } from './useChatOrganization';

export type ChatMutationActionsAdapter = {
  availableModels: ComputedRef<string[]>;
  fetchingModels: ComputedRef<boolean>;

  moveChatToGroup({
    chatId,
    targetGroupId,
  }: {
    chatId: string;
    targetGroupId: string | null;
  }): Promise<void>;

  toggleDebug(_args: Record<never, never>): Promise<void>;

  toggleDebugForChat({
    chatId,
  }: {
    chatId: string;
  }): Promise<void>;

  renameChat({
    id,
    newTitle,
  }: {
    id: string;
    newTitle: string;
  }): Promise<void>;

  generateChatTitle({
    chatId,
    titleModelIdOverride,
  }: {
    chatId: string;
    titleModelIdOverride: string | undefined;
  }): Promise<string | null | undefined>;

  abortTitleGeneration({
    chatId,
  }: {
    chatId: string | undefined;
  }): void;

  isGeneratingTitle({
    chatId,
  }: {
    chatId: string;
  }): boolean;

  updateChatSettings({
    id,
    updates,
  }: {
    id: string;
    updates: Partial<Pick<Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }): Promise<void>;

  fetchAvailableModels({
    chatId,
  }: {
    chatId: string | undefined;
  }): Promise<string[]>;

  updateChatModel({
    id,
    modelId,
  }: {
    id: string;
    modelId: string | undefined;
  }): Promise<void>;

  commitFullHistoryManipulation({
    chatId,
    messages,
    systemPrompt,
  }: {
    chatId: string;
    messages: HistoryItem[];
    systemPrompt: SystemPrompt | undefined;
  }): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useChatMutationActions(): ChatMutationActionsAdapter {
  const {
    currentBridge,
  } = useChatUiServices({});
  const chatOrganization = useChatOrganization();

  const availableModelsState = computed(() => availableModels.value);
  const fetchingModelsState = computed(() => fetchingModels.value);

  async function moveChatToGroup({
    chatId,
    targetGroupId,
  }: {
    chatId: string;
    targetGroupId: string | null;
  }) {
    await chatOrganization.moveChatToGroup({
      chatId,
      targetGroupId,
    });
  }

  async function toggleDebug(_args: Record<never, never>) {
    const currentChatId = currentBridge.getCurrentChatId({}) ?? undefined;
    if (currentChatId === undefined) {
      return;
    }

    await toggleDebugForChatId({
      chatId: currentChatId,
    });
  }

  async function toggleDebugForChat({
    chatId,
  }: {
    chatId: string;
  }) {
    await toggleDebugForChatId({
      chatId,
    });
  }

  async function renameChat({
    id,
    newTitle,
  }: {
    id: string;
    newTitle: string;
  }) {
    await renameChatById({
      chatId: id,
      title: newTitle,
    });
  }

  async function generateChatTitle({
    chatId,
    titleModelIdOverride,
  }: {
    chatId: string;
    titleModelIdOverride: string | undefined;
  }) {
    return await generateChatTitleForChat({
      chatId,
      titleModelIdOverride,
      signal: undefined,
    });
  }

  function abortTitleGeneration({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    abortTitleGenerationForChat({
      chatId,
    });
  }

  function isGeneratingTitle({
    chatId,
  }: {
    chatId: string;
  }) {
    return isGeneratingChatTitle({
      chatId,
    });
  }

  async function updateChatSettings({
    id,
    updates,
  }: {
    id: string;
    updates: Partial<Pick<Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    await updateChatSettingsById({
      chatId: id,
      updates,
    });
  }

  async function fetchAvailableModels({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    return await fetchAvailableModelsForChat({
      chatId,
    });
  }

  async function updateChatModel({
    id,
    modelId,
  }: {
    id: string;
    modelId: string | undefined;
  }) {
    await updateChatModelById({
      chatId: id,
      modelId,
    });
  }

  async function commitFullHistoryManipulation({
    chatId,
    messages,
    systemPrompt,
  }: {
    chatId: string;
    messages: HistoryItem[];
    systemPrompt: SystemPrompt | undefined;
  }) {
    await commitFullHistoryManipulationForChat({
      chatId,
      messages,
      systemPrompt,
    });
  }

  return {
    availableModels: availableModelsState,
    fetchingModels: fetchingModelsState,
    moveChatToGroup,
    toggleDebug,
    toggleDebugForChat,
    renameChat,
    generateChatTitle,
    abortTitleGeneration,
    isGeneratingTitle,
    updateChatSettings,
    fetchAvailableModels,
    updateChatModel,
    commitFullHistoryManipulation,
    TEST_ONLY: {},
  };
}
