import { computed, type ComputedRef } from 'vue';
import type { Attachment } from '@/models/types';
import type { ImageRequestParams } from '@/utils/image-generation';
import { useChat } from '@/composables/useChat';

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

type ChatImageStoreCompatibility = ReturnType<typeof useChat> & {
  sendImageRequestForChat?: ({
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
    chatId: string;
    prompt: string;
    width: number;
    height: number;
    count: number;
    steps: number | undefined;
    seed: number | 'browser_random' | undefined;
    persistAs: ImageRequestParams['persistAs'];
    attachments: Attachment[];
  }) => Promise<boolean>;
};

export function useChatImageActions(): ChatImageActionsAdapter {
  const chatStore = useChat() as ChatImageStoreCompatibility;

  const availableModels = computed(() => chatStore.availableModels?.value ?? []);

  function isImageMode({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return false;
    }

    return chatStore.isImageMode({ chatId });
  }

  function toggleImageMode({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return;
    }

    chatStore.toggleImageMode({ chatId });
  }

  function getResolution({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return { width: 512, height: 512 };
    }

    return chatStore.getResolution({ chatId });
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

    chatStore.updateResolution({ chatId, width, height });
  }

  function getCount({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return 1;
    }

    return chatStore.getCount({ chatId });
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

    chatStore.updateCount({ chatId, count });
  }

  function getPersistAs({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return 'original';
    }

    return chatStore.getPersistAs({ chatId });
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

    chatStore.updatePersistAs({ chatId, format });
  }

  function getSteps({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return undefined;
    }

    return chatStore.getSteps({ chatId });
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

    chatStore.updateSteps({ chatId, steps });
  }

  function getSeed({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return undefined;
    }

    return chatStore.getSeed({ chatId });
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

    chatStore.updateSeed({ chatId, seed });
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

    chatStore.setImageModel({ chatId, modelId });
  }

  function getSelectedImageModel({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId === undefined) {
      return undefined;
    }

    return chatStore.getSelectedImageModel({
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
    if (chatId !== undefined && typeof chatStore.sendImageRequestForChat === 'function') {
      return await chatStore.sendImageRequestForChat({
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

    if (typeof chatStore.sendImageRequest !== 'function') {
      return false;
    }

    return await chatStore.sendImageRequest({
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
    availableModels,
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
