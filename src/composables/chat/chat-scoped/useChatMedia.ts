import { computed, type ComputedRef, type Ref } from 'vue';
import type { Attachment } from '@/models/types';
import type { ImageRequestParams } from '@/utils/image-generation';
import { useChatImageActions } from '@/composables/chat/ui/useChatImageActions';

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

export function useChatMedia({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatMediaAdapter {
  const chatImageActions = useChatImageActions();

  const isImageMode = computed(() => {
    return chatImageActions.isImageMode({ chatId: chatId.value });
  });

  const resolution = computed(() => {
    return chatImageActions.getResolution({ chatId: chatId.value });
  });

  const count = computed(() => {
    return chatImageActions.getCount({ chatId: chatId.value });
  });

  const persistAs = computed(() => {
    return chatImageActions.getPersistAs({ chatId: chatId.value });
  });

  const steps = computed(() => {
    return chatImageActions.getSteps({ chatId: chatId.value });
  });

  const seed = computed(() => {
    return chatImageActions.getSeed({ chatId: chatId.value });
  });

  const selectedImageModel = computed(() => {
    return chatImageActions.getSelectedImageModel({
      chatId: chatId.value,
    });
  });

  function toggleImageMode(_args: Record<never, never>) {
    if (chatId.value === undefined) {
      return;
    }

    chatImageActions.toggleImageMode({ chatId: chatId.value });
  }

  function updateResolution({
    width,
    height,
  }: {
    width: number;
    height: number;
  }) {
    if (chatId.value === undefined) {
      return;
    }

    chatImageActions.updateResolution({
      chatId: chatId.value,
      width,
      height,
    });
  }

  function updateCount({
    count,
  }: {
    count: number;
  }) {
    if (chatId.value === undefined) {
      return;
    }

    chatImageActions.updateCount({ chatId: chatId.value, count });
  }

  function updatePersistAs({
    format,
  }: {
    format: 'original' | 'webp' | 'jpeg' | 'png';
  }) {
    if (chatId.value === undefined) {
      return;
    }

    chatImageActions.updatePersistAs({ chatId: chatId.value, format });
  }

  function updateSteps({
    steps,
  }: {
    steps: number | undefined;
  }) {
    if (chatId.value === undefined) {
      return;
    }

    chatImageActions.updateSteps({ chatId: chatId.value, steps });
  }

  function updateSeed({
    seed,
  }: {
    seed: number | 'browser_random' | undefined;
  }) {
    if (chatId.value === undefined) {
      return;
    }

    chatImageActions.updateSeed({ chatId: chatId.value, seed });
  }

  function setImageModel({
    modelId,
  }: {
    modelId: string;
  }) {
    if (chatId.value === undefined) {
      return;
    }

    chatImageActions.setImageModel({ chatId: chatId.value, modelId });
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
    if (chatId.value === undefined) {
      return false;
    }

    return await chatImageActions.sendImageRequest({
      chatId: chatId.value,
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
    availableModels: chatImageActions.availableModels,
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
