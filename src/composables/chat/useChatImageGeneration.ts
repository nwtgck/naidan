import { computed, type ComputedRef, type Ref } from 'vue';
import type { Attachment, LmParameters } from '@/models/types';
import { availableModels } from '@/composables/chat/global/chat-core-singletons';
import { useImageGeneration } from '@/composables/useImageGeneration';
import type { ImageRequestParams } from '@/utils/image-generation';
import { sendImageRequestForChat } from '@/composables/chat/chat-scoped/chat-image-flow';
import { sendMessageForChat } from '@/composables/chat/chat-scoped/chat-generation-flow';

export type ChatImageGenerationAdapter = {
  availableModels: Ref<string[]>;
  isImageMode: ComputedRef<boolean>;
  resolution: ComputedRef<{ width: number; height: number }>;
  count: ComputedRef<number>;
  persistAs: ComputedRef<ImageRequestParams['persistAs']>;
  steps: ComputedRef<number | undefined>;
  seed: ComputedRef<number | 'browser_random' | undefined>;
  selectedImageModel: ComputedRef<string | undefined>;

  toggleImageMode(): void;

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

  TEST_ONLY: Record<never, never>;
};

export function useChatImageGeneration({
  chatId,
}: {
  chatId: Readonly<Ref<string>>;
}): ChatImageGenerationAdapter {
  const imageGeneration = useImageGeneration();

  const isImageMode = computed(() => imageGeneration.isImageMode({ chatId: chatId.value }));
  const resolution = computed(() => imageGeneration.getResolution({ chatId: chatId.value }));
  const count = computed(() => imageGeneration.getCount({ chatId: chatId.value }));
  const persistAs = computed(() => imageGeneration.getPersistAs({ chatId: chatId.value }));
  const steps = computed(() => imageGeneration.getSteps({ chatId: chatId.value }));
  const seed = computed(() => imageGeneration.getSeed({ chatId: chatId.value }));
  const selectedImageModel = computed(() => {
    return imageGeneration.getSelectedImageModel({
      chatId: chatId.value,
      availableModels: availableModels.value,
    });
  });

  function toggleImageMode() {
    imageGeneration.toggleImageMode({ chatId: chatId.value });
  }

  function updateResolution({
    width,
    height,
  }: {
    width: number;
    height: number;
  }) {
    imageGeneration.updateResolution({ chatId: chatId.value, width, height });
  }

  function updateCount({
    count,
  }: {
    count: number;
  }) {
    imageGeneration.updateCount({ chatId: chatId.value, count });
  }

  function updatePersistAs({
    format,
  }: {
    format: 'original' | 'webp' | 'jpeg' | 'png';
  }) {
    imageGeneration.updatePersistAs({ chatId: chatId.value, format });
  }

  function updateSteps({
    steps,
  }: {
    steps: number | undefined;
  }) {
    imageGeneration.updateSteps({ chatId: chatId.value, steps });
  }

  function updateSeed({
    seed,
  }: {
    seed: number | 'browser_random' | undefined;
  }) {
    imageGeneration.updateSeed({ chatId: chatId.value, seed });
  }

  function setImageModel({
    modelId,
  }: {
    modelId: string;
  }) {
    imageGeneration.setImageModel({ chatId: chatId.value, modelId });
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
      sendMessage: ({ content, parentId, attachments }) => sendMessageForChat({
        chatId: id,
        content,
        parentId,
        attachments,
        lmParameters: undefined as LmParameters | undefined,
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
