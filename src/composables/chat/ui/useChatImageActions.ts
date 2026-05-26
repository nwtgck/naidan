import { computed, type ComputedRef } from 'vue';
import type { Attachment } from '@/models/types';
import { useSettings } from '@/composables/useSettings';
import { useImageGeneration } from '@/composables/useImageGeneration';
import { chatRuntimeStore, updateChatContent } from '@/composables/chat/global/chat-core-singletons';
import { createChatImageService } from '@/composables/chat/services/chat-image-service';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import type { ImageRequestParams } from '@/utils/image-generation';
import { useChatConversationActions } from './useChatConversationActions';
import { useChatUiServices } from './useChatUiServices';

export type ChatImageActionsAdapter = {
  availableModels: ComputedRef<string[]>;

  isImageMode({
    chatId,
  }: {
    chatId: string | undefined;
  }): boolean;

  toggleImageMode({
    chatId,
  }: {
    chatId: string | undefined;
  }): void;

  getResolution({
    chatId,
  }: {
    chatId: string | undefined;
  }): { width: number; height: number };

  updateResolution({
    chatId,
    width,
    height,
  }: {
    chatId: string | undefined;
    width: number;
    height: number;
  }): void;

  getCount({
    chatId,
  }: {
    chatId: string | undefined;
  }): number;

  updateCount({
    chatId,
    count,
  }: {
    chatId: string | undefined;
    count: number;
  }): void;

  getPersistAs({
    chatId,
  }: {
    chatId: string | undefined;
  }): ImageRequestParams['persistAs'];

  updatePersistAs({
    chatId,
    format,
  }: {
    chatId: string | undefined;
    format: 'original' | 'webp' | 'jpeg' | 'png';
  }): void;

  getSteps({
    chatId,
  }: {
    chatId: string | undefined;
  }): number | undefined;

  updateSteps({
    chatId,
    steps,
  }: {
    chatId: string | undefined;
    steps: number | undefined;
  }): void;

  getSeed({
    chatId,
  }: {
    chatId: string | undefined;
  }): number | 'browser_random' | undefined;

  updateSeed({
    chatId,
    seed,
  }: {
    chatId: string | undefined;
    seed: number | 'browser_random' | undefined;
  }): void;

  setImageModel({
    chatId,
    modelId,
  }: {
    chatId: string | undefined;
    modelId: string;
  }): void;

  getSelectedImageModel({
    chatId,
  }: {
    chatId: string | undefined;
  }): string | undefined;

  sendImageRequest({
    chatId,
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs,
    attachments,
  }: {
    chatId: string | undefined;
    prompt: string;
    width: number;
    height: number;
    count: number;
    steps: number | undefined;
    seed: number | 'browser_random' | undefined;
    persistAs: ImageRequestParams['persistAs'];
    attachments: Attachment[];
  }): Promise<boolean>;

  TEST_ONLY: Record<string, never>;
};

export function useChatImageActions(): ChatImageActionsAdapter {
  const { settings } = useSettings();
  const { currentBridge, derivedState, availableModels } = useChatUiServices({});
  const chatConversationActions = useChatConversationActions();
  const imageGeneration = useImageGeneration();
  const chatImageService = createChatImageService({
    getCurrentChat: () => currentBridge.getCurrentChat({}),
    getLiveChat: ({ chat }) => currentBridge.getChatTargetById({ id: chat.id }) ?? undefined,
    getAvailableModels: () => availableModels.value,
    getStorageType: () => settings.value.storageType,
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({
        chat,
        groups: derivedState.chatGroups.value,
        globalSettings: settings.value,
      });
      return {
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders ? [...resolved.endpointHttpHeaders] : undefined,
      };
    },
    performGeneration: imageGeneration.performBase64Generation,
    handleImageGenerationImpl: imageGeneration.handleImageGeneration,
    sendImageRequestImpl: imageGeneration.sendImageRequest,
    updateChatContent,
    triggerCurrentChat: ({ chatId }) => currentBridge.triggerCurrentChat({ chatId }),
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
    sendMessage: ({ chatId, content, parentId, attachments }) => chatConversationActions.sendMessage({
      chatId,
      content,
      parentId,
      attachments,
      lmParameters: undefined,
    }),
  });

  const availableModelsState = computed(() => availableModels.value);

  function isImageMode({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return false;
    }

    return imageGeneration.isImageMode({ chatId });
  }

  function toggleImageMode({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return;
    }

    imageGeneration.toggleImageMode({ chatId });
  }

  function getResolution({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return { width: 512, height: 512 };
    }

    return imageGeneration.getResolution({ chatId });
  }

  function updateResolution({
    chatId,
    width,
    height,
  }: {
    chatId: string | undefined;
    width: number;
    height: number;
  }) {
    if (chatId === undefined) {
      return;
    }

    imageGeneration.updateResolution({ chatId, width, height });
  }

  function getCount({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return 1;
    }

    return imageGeneration.getCount({ chatId });
  }

  function updateCount({
    chatId,
    count,
  }: {
    chatId: string | undefined;
    count: number;
  }) {
    if (chatId === undefined) {
      return;
    }

    imageGeneration.updateCount({ chatId, count });
  }

  function getPersistAs({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return 'original';
    }

    return imageGeneration.getPersistAs({ chatId });
  }

  function updatePersistAs({
    chatId,
    format,
  }: {
    chatId: string | undefined;
    format: 'original' | 'webp' | 'jpeg' | 'png';
  }) {
    if (chatId === undefined) {
      return;
    }

    imageGeneration.updatePersistAs({ chatId, format });
  }

  function getSteps({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return undefined;
    }

    return imageGeneration.getSteps({ chatId });
  }

  function updateSteps({
    chatId,
    steps,
  }: {
    chatId: string | undefined;
    steps: number | undefined;
  }) {
    if (chatId === undefined) {
      return;
    }

    imageGeneration.updateSteps({ chatId, steps });
  }

  function getSeed({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return undefined;
    }

    return imageGeneration.getSeed({ chatId });
  }

  function updateSeed({
    chatId,
    seed,
  }: {
    chatId: string | undefined;
    seed: number | 'browser_random' | undefined;
  }) {
    if (chatId === undefined) {
      return;
    }

    imageGeneration.updateSeed({ chatId, seed });
  }

  function setImageModel({
    chatId,
    modelId,
  }: {
    chatId: string | undefined;
    modelId: string;
  }) {
    if (chatId === undefined) {
      return;
    }

    imageGeneration.setImageModel({ chatId, modelId });
  }

  function getSelectedImageModel({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return undefined;
    }

    return imageGeneration.getSelectedImageModel({
      chatId,
      availableModels: availableModels.value,
    });
  }

  async function sendImageRequest({
    chatId,
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs,
    attachments,
  }: {
    chatId: string | undefined;
    prompt: string;
    width: number;
    height: number;
    count: number;
    steps: number | undefined;
    seed: number | 'browser_random' | undefined;
    persistAs: ImageRequestParams['persistAs'];
    attachments: Attachment[];
  }): Promise<boolean> {
    if (chatId !== undefined) {
      return await chatImageService.sendImageRequestForChat({
        chatId,
        prompt,
        width,
        height,
        count,
        steps,
        seed,
        persistAs,
        attachments,
      });
    }

    return await chatImageService.sendImageRequest({
      prompt,
      width,
      height,
      count,
      steps,
      seed,
      persistAs,
      attachments,
    });
  }

  return {
    availableModels: availableModelsState,
    isImageMode,
    toggleImageMode,
    getResolution,
    updateResolution,
    getCount,
    updateCount,
    getPersistAs,
    updatePersistAs,
    getSteps,
    updateSteps,
    getSeed,
    updateSeed,
    setImageModel,
    getSelectedImageModel,
    sendImageRequest,
    TEST_ONLY: {},
  };
}
