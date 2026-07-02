import { ensureStrings } from '@/strings';
import { generateId } from '@/01-models/id';
import { ref } from 'vue';
import { UNKNOWN_STEPS } from '@/01-models/lm';
import { useSettings } from '@/composables/useSettings';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { storageService } from '@/00-storage/service';
import {
  getImageGenerationModels,
  SENTINEL_IMAGE_PENDING,
  SENTINEL_IMAGE_PROCESSED,
  createImageRequestMarker,
  createImageResponseMarker,
  IMAGE_BLOCK_LANG,
  getDisplayDimensions,
  type GeneratedImageBlock,
  type ImageRequestParams,
} from '@/utils/image-generation';
import { reencodeImage } from '@/utils/image-processing';
import { naturalSort, sanitizeFilename } from '@/utils/string';
import type { Chat, ChatContent, Attachment } from '@/01-models/types';
import { findNodeInBranch } from '@/logic/chat-tree';
import { idToRaw } from '@/01-models/ids';
import type { BinaryObjectId, ChatId, MessageId } from '@/01-models/ids';
import { createModuleLoader } from '@/utils/module-loader';

const ollamaProviderModuleLoader = createModuleLoader({
  importModule: () => import('@/features/lm/ollama'),
  onPrefetchError: ({ error }) => {
    console.error('Failed to prefetch image generation provider:', error);
  },
});

const lmFetchFactoryModuleLoader = createModuleLoader({
  importModule: () => import('@/features/lm/fetchFactory'),
  onPrefetchError: ({ error }) => {
    console.error('Failed to prefetch LM fetch factory:', error);
  },
});

// Shared state across all instances to maintain consistency
const imageModeMap = ref(new Map<ChatId, boolean>());
const imageResolutionMap = ref(new Map<ChatId, { width: number, height: number }>());
const imageCountMap = ref(new Map<ChatId, number>());
const imageModelOverrideMap = ref(new Map<ChatId, string>());
const imagePersistAsMap = ref(new Map<ChatId, ImageRequestParams['persistAs']>());
const imageStepsMap = ref(new Map<ChatId, number | undefined>());
const imageSeedMap = ref(new Map<ChatId, number | 'browser_random' | undefined>());
const imageProgressMap = ref(new Map<ChatId, { currentStep: number, totalSteps: number } | undefined>());

export async function prefetchImageGenerationRuntime(): Promise<void> {
  await Promise.all([
    ollamaProviderModuleLoader.prefetch(),
    lmFetchFactoryModuleLoader.prefetch(),
  ]);
}

export function useImageGeneration() {
  const { settings } = useSettings();
  const isImageMode = ({ chatId }: { chatId: ChatId }) => !!imageModeMap.value.get(chatId);

  const toggleImageMode = ({ chatId }: { chatId: ChatId }) => {
    imageModeMap.value.set(chatId, !imageModeMap.value.get(chatId));
  };

  const getResolution = ({ chatId }: { chatId: ChatId }) => {
    return imageResolutionMap.value.get(chatId) || { width: 512, height: 512 };
  };

  const updateResolution = ({ chatId, width, height }: {
    chatId: ChatId,
    width: number,
    height: number,
  }) => {
    imageResolutionMap.value.set(chatId, { width, height });
  };

  const getCount = ({ chatId }: { chatId: ChatId }) => {
    return imageCountMap.value.get(chatId) || 1;
  };

  const updateCount = ({ chatId, count }: {
    chatId: ChatId,
    count: number,
  }) => {
    imageCountMap.value.set(chatId, count);
  };

  const getSteps = ({ chatId }: { chatId: ChatId }) => {
    return imageStepsMap.value.get(chatId);
  };

  const updateSteps = ({ chatId, steps }: {
    chatId: ChatId,
    steps: number | undefined,
  }) => {
    imageStepsMap.value.set(chatId, steps);
  };

  const getSeed = ({ chatId }: { chatId: ChatId }) => {
    // If the chatId is not in the map, return the default ('browser_random')
    if (!imageSeedMap.value.has(chatId)) {
      return 'browser_random';
    }
    return imageSeedMap.value.get(chatId);
  };

  const updateSeed = ({ chatId, seed }: {
    chatId: ChatId,
    seed: number | 'browser_random' | undefined,
  }) => {
    imageSeedMap.value.set(chatId, seed);
  };

  const getPersistAs = ({ chatId }: { chatId: ChatId }): ImageRequestParams['persistAs'] => {
    return imagePersistAsMap.value.get(chatId) || 'original';
  };

  const updatePersistAs = ({ chatId, format }: {
    chatId: ChatId,
    format: ImageRequestParams['persistAs'],
  }) => {
    imagePersistAsMap.value.set(chatId, format);
  };

  const setImageModel = ({ chatId, modelId }: {
    chatId: ChatId,
    modelId: string | undefined,
  }) => {
    if (modelId === undefined) {
      imageModelOverrideMap.value.delete(chatId);
    } else {
      imageModelOverrideMap.value.set(chatId, modelId);
    }
  };

  const getSelectedImageModel = ({ chatId, availableModels }: {
    chatId: ChatId,
    availableModels: string[],
  }) => {
    const allImageModels = getImageGenerationModels({ models: availableModels });
    const overridden = imageModelOverrideMap.value.get(chatId);
    if (overridden && allImageModels.includes(overridden)) {
      return overridden;
    }
    return allImageModels[0] || undefined;
  };

  const getSortedImageModels = ({ availableModels }: {
    availableModels: string[],
  }) => {
    return naturalSort({ values: getImageGenerationModels({ models: availableModels }) });
  };

  const performBase64Generation = async ({ prompt, model, width, height, steps, seed, images, endpointUrl, endpointHttpHeaders, onProgress, signal }: {
    prompt: string,
    model: string,
    width: number,
    height: number,
    steps: number | undefined,
    seed: number | undefined,
    images: { blob: Blob }[],
    endpointUrl: string,
    endpointHttpHeaders: [string, string][] | undefined,
    onProgress: ({ currentStep, totalSteps }: { currentStep: number, totalSteps: number }) => void,
    signal: AbortSignal | undefined,
  }): Promise<{ image: Blob, totalSteps: number | typeof UNKNOWN_STEPS }> => {
    signal?.throwIfAborted();
    const [{ OllamaProvider }, { createLmFetch }] = await Promise.all([
      ollamaProviderModuleLoader.load(),
      lmFetchFactoryModuleLoader.load(),
    ]);
    signal?.throwIfAborted();
    const provider = new OllamaProvider({
      endpoint: endpointUrl,
      headers: endpointHttpHeaders,
      fetcher: createLmFetch({
        endpointUrl,
        fakeLmDebugModeStatus: settings.value.experimental?.fakeLm ?? 'disabled',
      }),
    });

    return await provider.generateImage({
      prompt,
      model,
      width,
      height,
      steps,
      seed,
      images,
      onProgress,
      signal,
    });
  };

  const handleImageGeneration = async ({
    chatId,
    assistantId,
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs: requestedPersistAs,
    images,
    model: requestedModel,
    availableModels,
    endpointUrl,
    endpointHttpHeaders,
    storageType,
    signal,
    getLiveChat,
    updateChatContent,
    triggerChatRef,
    incTask,
    decTask,
  }: {
    chatId: ChatId,
    assistantId: MessageId,
    prompt: string,
    width: number,
    height: number,
    count: number | undefined,
    steps: number | undefined,
    seed: number | 'browser_random' | undefined,
    persistAs: ImageRequestParams['persistAs'] | undefined,
    images: { blob: Blob }[],
    model: string | undefined,
    availableModels: string[],
    endpointUrl: string,
    endpointHttpHeaders: [string, string][] | undefined,
    storageType: 'opfs' | 'local' | 'memory',
    signal: AbortSignal | undefined,
    getLiveChat: ({ chat }: { chat: Chat }) => Chat | undefined,

    updateChatContent: ({ chatId, updater }: { chatId: ChatId, updater: ({ current }: { current: ChatContent }) => ChatContent }) => Promise<void>,
    triggerChatRef: ({ chatId }: { chatId: ChatId }) => void,
    incTask: ({ chatId, type }: { chatId: ChatId, type: 'process' }) => void,
    decTask: ({ chatId, type }: { chatId: ChatId, type: 'process' }) => void,
  }) => {
    const target = getLiveChat({ chat: { id: chatId } as Chat });
    if (!target) return;
    const mutableChat = target;
    const assistantNode = findNodeInBranch({ items: mutableChat.root.items, targetId: assistantId });
    if (!assistantNode) return;
    switch (assistantNode.role) {
    case 'assistant':
      break;
    case 'user':
    case 'system':
    case 'tool':
      return;
    default: {
      const _ex: never = assistantNode;
      throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
    }
    }

    // Prioritize the model requested in the sentinel (for regeneration/history)
    // Fallback to the currently selected model or the first available one
    const imageModel = (requestedModel && availableModels.includes(requestedModel))
      ? requestedModel
      : getSelectedImageModel({ chatId, availableModels });

    if (!imageModel) {
      assistantNode.error = await ensureStrings.useImageGeneration__no_suitable_image_generation_model_found();
      assistantNode.content = await ensureStrings.useImageGeneration__failed_to_generate_image();
      return;
    }

    incTask({ chatId, type: 'process' });
    try {
      const imageCount = count || getCount({ chatId });
      const persistAs = requestedPersistAs || getPersistAs({ chatId });
      const responseMarker = createImageResponseMarker({ count: imageCount });
      assistantNode.content = responseMarker + SENTINEL_IMAGE_PENDING;

      // Ensure the assistant node uses the actual model ID for metadata
      assistantNode.modelId = imageModel;
      triggerChatRef({ chatId });
      await updateChatContent({
        chatId: mutableChat.id,

        updater: ({ current }) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId }),
      });

      const blocks: GeneratedImageBlock[] = [];

      for (let i = 0; i < imageCount; i++) {
        if (signal?.aborted) break;

        // Clear progress for the new image starting to avoid showing stale progress from the previous image
        imageProgressMap.value.delete(chatId);

        let activeSeed: number | undefined = undefined;
        if (typeof seed === 'number' && seed >= 0) {
          activeSeed = seed;
        } else if (seed === 'browser_random') {
          activeSeed = crypto.getRandomValues(new Uint32Array(1))[0];
          if (activeSeed !== undefined && activeSeed < 1) activeSeed = 1;
        }

        const { image: blob, totalSteps } = await performBase64Generation({
          prompt,
          model: imageModel,
          width,
          height,
          steps,
          seed: activeSeed,
          images,
          endpointUrl,
          endpointHttpHeaders,
          onProgress: ({ currentStep, totalSteps }) => {
            imageProgressMap.value.set(chatId, { currentStep, totalSteps });
          },
          signal,
        });
        if (!blob) throw new Error(await ensureStrings.useImageGeneration__failed_to_generate_image());

        let finalBlob = blob;
        let extension = '.png';

        if (persistAs && persistAs !== 'original') {
          try {
            finalBlob = await reencodeImage({ blob, format: persistAs });
            extension = `.${persistAs}`;
          } catch (e) {
            const { addErrorEvent } = useGlobalEvents();
            addErrorEvent({
              source: 'useImageGeneration:handleImageGeneration',
              message: await ensureStrings.useImageGeneration__failed_to_reencode_image({ format: persistAs }),
              details: e instanceof Error ? e : String(e),
            });
          }
        }

        switch (storageType) {
        case 'opfs':
        case 'memory': {
          const binaryObjectId = generateId<BinaryObjectId>();
          const fileName = sanitizeFilename({
            base: prompt,
            suffix: extension,
            fallback: `generated-${Date.now()}-${i}`,
          });
          await storageService.saveFile({ blob: finalBlob, binaryObjectId, name: fileName });

          const { width: dw, height: dh } = getDisplayDimensions({ width, height });

          blocks.push({
            binaryObjectId: idToRaw({ id: binaryObjectId }),
            displayWidth: dw,
            displayHeight: dh,
            width,
            height,
            prompt, // Use original prompt without (seed: ...)
            steps: totalSteps === UNKNOWN_STEPS ? undefined : totalSteps,
            seed: activeSeed,
          });

          const blocksContent = blocks.map(b => `\`\`\`${IMAGE_BLOCK_LANG}\n${JSON.stringify(b, null, 2)}\n\`\`\``).join('\n\n');
          assistantNode.content = responseMarker + SENTINEL_IMAGE_PENDING + '\n\n' + blocksContent;
          break;
        }
        case 'local': {
          const url = URL.createObjectURL(finalBlob);
          const { width: dw, height: dh } = getDisplayDimensions({ width, height });
          const blockHtml = `<img src="${url}" width="${dw}" height="${dh}" alt="${await ensureStrings.SHARED__generated_image()}" class="rounded-xl shadow-lg border border-gray-100 dark:border-gray-800 my-2 max-w-full h-auto">`;

          if (i === 0) {
            assistantNode.content = responseMarker + SENTINEL_IMAGE_PENDING + '\n\n' + blockHtml;
          } else {
            assistantNode.content += '\n\n' + blockHtml;
          }
          break;
        }
        default: {
          const _ex: never = storageType;
          throw new Error(`Unhandled storage type: ${_ex}`);
        }
        }

        triggerChatRef({ chatId });
        await updateChatContent({
          chatId: mutableChat.id,

          updater: ({ current }) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId }),
        });
      }
      // Finalize: replace PENDING with PROCESSED
      assistantNode.content = assistantNode.content.replace(SENTINEL_IMAGE_PENDING, signal?.aborted ? '' : SENTINEL_IMAGE_PROCESSED);
    } catch (e) {
      assistantNode.error = (e as Error).message;
      // Cleanup sentinel on error
      assistantNode.content = assistantNode.content.replace(SENTINEL_IMAGE_PENDING, '');
      if (assistantNode.content.trim() === '') {
        assistantNode.content = await ensureStrings.useImageGeneration__failed_to_generate_image();
      }
    } finally {
      imageProgressMap.value.delete(chatId);
      decTask({ chatId, type: 'process' });
      await updateChatContent({
        chatId: mutableChat.id,

        updater: ({ current }) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId }),
      });
      triggerChatRef({ chatId });
    }
  };


  const sendImageRequest = async ({
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs,
    chatId,
    attachments,
    availableModels,
    sendMessage,
  }: {
    prompt: string,
    width: number,
    height: number,
    count: number,
    steps: number | undefined,
    seed: number | 'browser_random' | undefined,
    persistAs: ImageRequestParams['persistAs'],
    chatId: ChatId,
    attachments: Attachment[],
    availableModels: string[],
    sendMessage: ({ content, parentId, attachments }: { content: string, parentId: MessageId | undefined, attachments: Attachment[] }) => Promise<boolean>,
  }): Promise<boolean> => {
    const prevMode = !!imageModeMap.value.get(chatId);
    const prevRes = imageResolutionMap.value.get(chatId);
    const prevCount = imageCountMap.value.get(chatId);
    const prevSteps = imageStepsMap.value.get(chatId);
    const prevSeed = imageSeedMap.value.get(chatId);
    const prevPersistAs = imagePersistAsMap.value.get(chatId);
    const model = getSelectedImageModel({ chatId, availableModels });

    imageModeMap.value.set(chatId, true);
    imageResolutionMap.value.set(chatId, { width, height });
    imageCountMap.value.set(chatId, count);
    imageStepsMap.value.set(chatId, steps);
    imageSeedMap.value.set(chatId, seed);
    imagePersistAsMap.value.set(chatId, persistAs);

    try {
      // Sentinel for history needs a string or number.
      const seedParam = seed === 'browser_random' ? 'browser_random' : seed;

      const content = model
        ? createImageRequestMarker({ width, height, model, count, persistAs, steps, seed: seedParam }) + prompt
        : prompt;
      return await sendMessage({ content, parentId: undefined, attachments });
    } finally {
      imageModeMap.value.set(chatId, prevMode);
      if (prevRes) imageResolutionMap.value.set(chatId, prevRes);
      if (prevCount !== undefined) imageCountMap.value.set(chatId, prevCount);
      imageStepsMap.value.set(chatId, prevSteps);
      imageSeedMap.value.set(chatId, prevSeed);
      if (prevPersistAs !== undefined) imagePersistAsMap.value.set(chatId, prevPersistAs);
    }
  };

  return {
    imageModeMap,
    imageResolutionMap,
    imageCountMap,
    imageStepsMap,
    imageSeedMap,
    imagePersistAsMap,
    imageProgressMap,
    imageModelOverrideMap,
    isImageMode,
    toggleImageMode,
    getResolution,
    updateResolution,
    getCount,
    updateCount,
    getSteps,
    updateSteps,
    getSeed,
    updateSeed,
    getPersistAs,
    updatePersistAs,
    setImageModel,
    getSelectedImageModel,
    getSortedImageModels,
    performBase64Generation,
    handleImageGeneration,
    sendImageRequest,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
