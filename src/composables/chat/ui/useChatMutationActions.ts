import { computed, type ComputedRef } from 'vue';
import type { Chat } from '@/models/types';
import type { HistoryItem } from '@/utils/chat-tree';
import type { SystemPrompt } from '@/models/types';
import { storageService } from '@/services/storage';
import { useSettings } from '@/composables/useSettings';
import {
  chatRuntimeStore,
  currentChatRef,
  fetchingModels,
  getLiveChat,
  isGeneratingTitle as isTitleGenerating,
  isProcessing,
  liveChatRegistry,
  loadData,
  registerLiveInstance,
  updateChatContent,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';
import { createChatHistoryService } from '@/composables/chat/services/chat-history-service';
import { createChatTitleService } from '@/composables/chat/services/chat-title-service';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import { useChatUiServices } from './useChatUiServices';

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
  const { settings } = useSettings();
  const {
    availableModels,
    currentBridge,
    derivedState,
    hierarchyService,
    metadataService,
    modelService,
    openService,
  } = useChatUiServices({});
  const titleService = createChatTitleService({
    getCurrentChatId: () => currentBridge.getCurrentChatId({}),
    getChatTarget: ({ chatId }) => currentBridge.getChatTargetByOptionalId({ chatId }),
    getLiveChat: ({ chat }) => currentBridge.getChatTargetById({ id: chat.id }) ?? chat,
    registerLiveInstance,
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({
        chat,
        groups: derivedState.chatGroups.value,
        globalSettings: settings.value,
      });
      return {
        endpointType: resolved.endpointType,
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders,
        modelId: resolved.modelId,
        titleModelId: resolved.titleModelId,
        lmParameters: resolved.lmParameters,
      };
    },
    updateChatMeta,
    loadData,
    triggerCurrentChat: ({ chatId }) => currentBridge.triggerCurrentChat({ chatId }),
    runtimeStore: chatRuntimeStore,
    getFallbackLanguage: (_args) => {
      const typeOfNavigator = typeof navigator;
      switch (typeOfNavigator) {
      case 'undefined':
        return 'en';
      case 'object':
      case 'boolean':
      case 'string':
      case 'number':
      case 'function':
      case 'symbol':
      case 'bigint':
        return navigator.language;
      default: {
        const _ex: never = typeOfNavigator;
        return _ex;
      }
      }
    },
  });
  const chatHistoryService = createChatHistoryService({
    currentChatRef,
    liveChatRegistry,
    getLiveChat,
    registerLiveInstance,
    updateChatContent,
    updateChatMeta,
    updateHierarchy: updater => storageService.updateHierarchy(updater),
    loadData,
    openChat: ({ id }) => openService.openChat({ id, leafId: undefined }),
    canPersistBinary: () => storageService.canPersistBinary,
    saveFile: ({ blob, binaryObjectId, originalName }) => storageService.saveFile(blob, binaryObjectId, originalName),
    isProcessing,
    abortChat: ({ chatId: _chatId }) => {},
    sendMessage: async ({ content: _content, parentId: _parentId, attachments: _attachments, chatTarget: _chatTarget, lmParameters: _lmParameters }) => {},
    triggerCurrentChat: ({ chatId }) => currentBridge.triggerCurrentChat({ chatId }),
  });

  const availableModelsState = computed(() => availableModels.value);
  const fetchingModelsState = computed(() => fetchingModels.value);

  async function moveChatToGroup({
    chatId,
    targetGroupId,
  }: {
    chatId: string;
    targetGroupId: string | null;
  }) {
    await hierarchyService.moveChatToGroup({
      chatId,
      targetGroupId,
    });
  }

  async function toggleDebug(_args: Record<never, never>) {
    await metadataService.toggleDebug({});
  }

  async function toggleDebugForChat({
    chatId,
  }: {
    chatId: string;
  }) {
    await metadataService.toggleDebugForChat({
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
    await metadataService.renameChat({
      id,
      newTitle,
    });
  }

  async function generateChatTitle({
    chatId,
    titleModelIdOverride,
  }: {
    chatId: string;
    titleModelIdOverride: string | undefined;
  }) {
    return await titleService.generateChatTitle({
      chatId,
      signal: undefined,
      titleModelIdOverride,
    });
  }

  function abortTitleGeneration({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    titleService.abortTitleGeneration({
      chatId,
    });
  }

  function isGeneratingTitle({
    chatId,
  }: {
    chatId: string;
  }) {
    return isTitleGenerating({
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
    await metadataService.updateChatSettings({
      id,
      updates,
    });
  }

  async function fetchAvailableModels({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    return await modelService.fetchAvailableModels({
      chatId,
      customEndpoint: undefined,
    });
  }

  async function updateChatModel({
    id,
    modelId,
  }: {
    id: string;
    modelId: string | undefined;
  }) {
    await metadataService.updateChatModel({
      id,
      modelId: modelId ?? '',
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
    await chatHistoryService.commitFullHistoryManipulation({
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
