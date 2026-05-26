import { computed, type ComputedRef, type Ref } from 'vue';
import type { Attachment } from '@/models/types';
import { availableModels } from '@/composables/chat/global/chat-core-singletons';
import { useImageGeneration } from '@/composables/useImageGeneration';
import type { ImageRequestParams } from '@/utils/image-generation';
import { sendImageRequestForChat } from './chat-image-helpers';
import { useChatConversationActions } from '@/composables/chat/ui/useChatConversationActions';

export type ChatImageGenerationAdapter = {
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

export function useChatImageGeneration({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatImageGenerationAdapter {
  const imageGeneration = useImageGeneration();
  const chatConversationActions = useChatConversationActions();

  const isImageMode = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return false;
    }
    return imageGeneration.isImageMode({ chatId: id });
  });

  const resolution = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return { width: 512, height: 512 };
    }
    return imageGeneration.getResolution({ chatId: id });
  });

  const count = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return 1;
    }
    return imageGeneration.getCount({ chatId: id });
  });

  const persistAs = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return 'original';
    }
    return imageGeneration.getPersistAs({ chatId: id });
  });

  const steps = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return undefined;
    }
    return imageGeneration.getSteps({ chatId: id });
  });

  const seed = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return undefined;
    }
    return imageGeneration.getSeed({ chatId: id });
  });

  const selectedImageModel = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return undefined;
    }
    return imageGeneration.getSelectedImageModel({
      chatId: id,
      availableModels: availableModels.value,
    });
  });

  function toggleImageMode(_args: Record<never, never>) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }
    imageGeneration.toggleImageMode({ chatId: id });
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
    imageGeneration.updateResolution({ chatId: id, width, height });
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
    imageGeneration.updateCount({ chatId: id, count });
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
    imageGeneration.updatePersistAs({ chatId: id, format });
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
    imageGeneration.updateSteps({ chatId: id, steps });
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
    imageGeneration.updateSeed({ chatId: id, seed });
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
    imageGeneration.setImageModel({ chatId: id, modelId });
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

    return await sendImageRequestForChat({
      chatId: id,
      prompt,
      width,
      height,
      count,
      steps,
      seed,
      persistAs,
      attachments,
      availableModels: availableModels.value,
      sendMessage: ({ content, parentId, attachments }) => chatConversationActions.sendMessage({
        chatId: id,
        content,
        parentId,
        attachments,
        lmParameters: undefined,
      }),
    });
  }

  return {
    availableModels,
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
    TEST_ONLY: {},
  };
}
