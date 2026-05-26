import { computed, type ComputedRef } from 'vue';
import type { Chat } from '@/models/types';
import type { HistoryItem } from '@/utils/chat-tree';
import type { SystemPrompt } from '@/models/types';
import { useChat } from '@/composables/useChat';

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
    chatId: string;
  }): Promise<string[]>;

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

type ChatMutationStoreCompatibility = ReturnType<typeof useChat> & {
  toggleDebugForChat?: ({
    chatId,
  }: {
    chatId: string;
  }) => Promise<void>;
  isGeneratingTitle?: ({
    chatId,
  }: {
    chatId: string;
  }) => boolean;
  generatingTitle?: {
    value: boolean;
  };
};

export function useChatMutationActions(): ChatMutationActionsAdapter {
  const chatStore = useChat() as ChatMutationStoreCompatibility;

  const availableModels = computed(() => chatStore.availableModels?.value ?? []);
  const fetchingModels = computed(() => chatStore.fetchingModels?.value ?? false);

  async function moveChatToGroup({
    chatId,
    targetGroupId,
  }: {
    chatId: string;
    targetGroupId: string | null;
  }) {
    await chatStore.moveChatToGroup({
      chatId,
      targetGroupId,
    });
  }

  async function toggleDebug(_args: Record<never, never>) {
    await chatStore.toggleDebug({});
  }

  async function toggleDebugForChat({
    chatId,
  }: {
    chatId: string;
  }) {
    if (typeof chatStore.toggleDebugForChat === 'function') {
      await chatStore.toggleDebugForChat({
        chatId,
      });
      return;
    }

    await chatStore.toggleDebug({});
  }

  async function renameChat({
    id,
    newTitle,
  }: {
    id: string;
    newTitle: string;
  }) {
    await chatStore.renameChat({
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
    return await chatStore.generateChatTitle({
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
    chatStore.abortTitleGeneration({
      chatId,
    });
  }

  function isGeneratingTitle({
    chatId,
  }: {
    chatId: string;
  }) {
    if (typeof chatStore.isGeneratingTitle === 'function') {
      return chatStore.isGeneratingTitle({
        chatId,
      });
    }

    return chatStore.generatingTitle?.value ?? false;
  }

  async function updateChatSettings({
    id,
    updates,
  }: {
    id: string;
    updates: Partial<Pick<Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    await chatStore.updateChatSettings({
      id,
      updates,
    });
  }

  async function fetchAvailableModels({
    chatId,
  }: {
    chatId: string;
  }) {
    return await chatStore.fetchAvailableModels({
      chatId,
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
    await chatStore.commitFullHistoryManipulation({
      chatId,
      messages,
      systemPrompt,
    });
  }

  return {
    availableModels,
    fetchingModels,
    moveChatToGroup,
    toggleDebug,
    toggleDebugForChat,
    renameChat,
    generateChatTitle,
    abortTitleGeneration,
    isGeneratingTitle,
    updateChatSettings,
    fetchAvailableModels,
    commitFullHistoryManipulation,
    TEST_ONLY: {},
  };
}
