import { computed, type ComputedRef, type Ref } from 'vue';
import type { Attachment } from '@/models/types';
import type { ImageRequestParams } from '@/utils/image-generation';
import { useChat } from '@/composables/useChat';

export type ChatMediaAdapter = {
  availableModels: Ref<string[]>;
  isImageMode: ComputedRef<boolean>;
  resolution: ComputedRef<{ width: number; height: number }>;
  count: ComputedRef<number>;
  persistAs: ComputedRef<ImageRequestParams['persistAs']>;
  steps: ComputedRef<number | undefined>;
  seed: ComputedRef<number | 'browser_random' | undefined>;
  selectedImageModel: ComputedRef<string | undefined>;

  toggleImageMode(_args: Record<never, never>): void;

  updateResolution({
    width,
    height,
  }: {
    width: number;
    height: number;
  }): void;

  updateCount({
    count,
  }: {
    count: number;
  }): void;

  updatePersistAs({
    format,
  }: {
    format: 'original' | 'webp' | 'jpeg' | 'png';
  }): void;

  updateSteps({
    steps,
  }: {
    steps: number | undefined;
  }): void;

  updateSeed({
    seed,
  }: {
    seed: number | 'browser_random' | undefined;
  }): void;

  setImageModel({
    modelId,
  }: {
    modelId: string;
  }): void;

  sendImageRequest({
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs,
    attachments,
  }: {
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

type ChatMediaStoreCompatibility = ReturnType<typeof useChat> & {
  sendImageRequest?: ({
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs,
    attachments,
  }: {
    prompt: string;
    width: number;
    height: number;
    count: number;
    steps: number | undefined;
    seed: number | 'browser_random' | undefined;
    persistAs: ImageRequestParams['persistAs'];
    attachments: Attachment[];
  }) => Promise<boolean>;
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

export function useChatMedia({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatMediaAdapter {
  const chatStore = useChat() as ChatMediaStoreCompatibility;

  const isImageMode = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return false;
    }

    return chatStore.isImageMode({ chatId: id });
  });

  const resolution = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return { width: 512, height: 512 };
    }

    return chatStore.getResolution({ chatId: id });
  });

  const count = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return 1;
    }

    return chatStore.getCount({ chatId: id });
  });

  const persistAs = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return 'original';
    }

    return chatStore.getPersistAs({ chatId: id });
  });

  const steps = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return undefined;
    }

    return chatStore.getSteps({ chatId: id });
  });

  const seed = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return undefined;
    }

    return chatStore.getSeed({ chatId: id });
  });

  const selectedImageModel = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return undefined;
    }

    return chatStore.getSelectedImageModel({
      chatId: id,
      availableModels: chatStore.availableModels.value,
    });
  });

  function toggleImageMode(_args: Record<never, never>) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    chatStore.toggleImageMode({ chatId: id });
  }

  function updateResolution({
    width,
    height,
  }: {
    width: number;
    height: number;
  }) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    chatStore.updateResolution({ chatId: id, width, height });
  }

  function updateCount({
    count,
  }: {
    count: number;
  }) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    chatStore.updateCount({ chatId: id, count });
  }

  function updatePersistAs({
    format,
  }: {
    format: 'original' | 'webp' | 'jpeg' | 'png';
  }) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    chatStore.updatePersistAs({ chatId: id, format });
  }

  function updateSteps({
    steps,
  }: {
    steps: number | undefined;
  }) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    chatStore.updateSteps({ chatId: id, steps });
  }

  function updateSeed({
    seed,
  }: {
    seed: number | 'browser_random' | undefined;
  }) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    chatStore.updateSeed({ chatId: id, seed });
  }

  function setImageModel({
    modelId,
  }: {
    modelId: string;
  }) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    chatStore.setImageModel({ chatId: id, modelId });
  }

  async function sendImageRequest({
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs,
    attachments,
  }: {
    prompt: string;
    width: number;
    height: number;
    count: number;
    steps: number | undefined;
    seed: number | 'browser_random' | undefined;
    persistAs: ImageRequestParams['persistAs'];
    attachments: Attachment[];
  }): Promise<boolean> {
    const id = chatId.value;
    if (id === undefined) {
      return false;
    }

    if (typeof chatStore.sendImageRequestForChat === 'function') {
      return await chatStore.sendImageRequestForChat({
        chatId: id,
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

    if (typeof chatStore.sendImageRequest === 'function') {
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

    return false;
  }

  return {
    availableModels: chatStore.availableModels,
    isImageMode,
    resolution,
    count,
    persistAs,
    steps,
    seed,
    selectedImageModel,
    toggleImageMode,
    updateResolution,
    updateCount,
    updatePersistAs,
    updateSteps,
    updateSeed,
    setImageModel,
    sendImageRequest,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
