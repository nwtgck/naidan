import { generateId } from '../utils/id';
import { ref } from 'vue';
import { OllamaProvider } from '../services/llm';
import { storageService } from '../services/storage';
import {
  getImageGenerationModels,
  SENTINEL_IMAGE_PENDING,
  SENTINEL_IMAGE_PROCESSED,
  createImageRequestMarker,
  createImageResponseMarker,
  IMAGE_BLOCK_LANG,
  type GeneratedImageBlock,
  type ImageRequestParams
} from '../utils/image-generation';
import { reencodeImage } from '../utils/image-processing';
import { naturalSort, sanitizeFilename } from '../utils/string';
import type { Chat, ChatContent, Attachment } from '../models/types';
import { findNodeInBranch } from '../utils/chat-tree';

// Shared state across all instances to maintain consistency
const imageModeMap = ref<Record<string, boolean>>({});
const imageResolutionMap = ref<Record<string, { width: number, height: number }>>({});
const imageCountMap = ref<Record<string, number>>({});
const imageModelOverrideMap = ref<Record<string, string>>({});
const imagePersistAsMap = ref<Record<string, ImageRequestParams['persistAs']>>({});
const imageStepsMap = ref<Record<string, number | undefined>>({});
const imageSeedMap = ref<Record<string, number | 'browser_random' | undefined>>({});
const imageProgressMap = ref<Record<string, { currentStep: number, totalSteps: number } | undefined>>({});

export function useImageGeneration() {
  const isImageMode = ({ chatId }: { chatId: string }) => !!imageModeMap.value[chatId];

  const toggleImageMode = ({ chatId }: { chatId: string }) => {
    imageModeMap.value[chatId] = !imageModeMap.value[chatId];
  };

  const getResolution = ({ chatId }: { chatId: string }) => {
    return imageResolutionMap.value[chatId] || { width: 512, height: 512 };
  };

  const updateResolution = ({ chatId, width, height }: {
    chatId: string,
    width: number,
    height: number
  }) => {
    imageResolutionMap.value[chatId] = { width, height };
  };

  const getCount = ({ chatId }: { chatId: string }) => {
    return imageCountMap.value[chatId] || 1;
  };

  const updateCount = ({ chatId, count }: {
    chatId: string,
    count: number
  }) => {
    imageCountMap.value[chatId] = count;
  };

  const getSteps = ({ chatId }: { chatId: string }) => {
    return imageStepsMap.value[chatId];
  };

  const updateSteps = ({ chatId, steps }: {
    chatId: string,
    steps: number | undefined
  }) => {
    imageStepsMap.value[chatId] = steps;
  };

  const getSeed = ({ chatId }: { chatId: string }) => {
    // If the chatId is not in the map, return the default ('browser_random')
    if (!(chatId in imageSeedMap.value)) {
      return 'browser_random';
    }
    return imageSeedMap.value[chatId];
  };

  const updateSeed = ({ chatId, seed }: {
    chatId: string,
    seed: number | 'browser_random' | undefined
  }) => {
    imageSeedMap.value[chatId] = seed;
  };

  const getPersistAs = ({ chatId }: { chatId: string }): ImageRequestParams['persistAs'] => {
    return imagePersistAsMap.value[chatId] || 'original';
  };

  const updatePersistAs = ({ chatId, format }: {
    chatId: string,
    format: ImageRequestParams['persistAs']
  }) => {
    imagePersistAsMap.value[chatId] = format;
  };

  const setImageModel = ({ chatId, modelId }: {
    chatId: string,
    modelId: string | undefined
  }) => {
    if (modelId === undefined) {
      delete imageModelOverrideMap.value[chatId];
    } else {
      imageModelOverrideMap.value[chatId] = modelId;
    }
  };

  const getSelectedImageModel = ({ chatId, availableModels }: {
    chatId: string,
    availableModels: string[]
  }) => {
    const allImageModels = getImageGenerationModels(availableModels);
    const overridden = imageModelOverrideMap.value[chatId];
    if (overridden && allImageModels.includes(overridden)) {
      return overridden;
    }
    return allImageModels[0] || undefined;
  };

  const getSortedImageModels = ({ availableModels }: {
    availableModels: string[]
  }) => {
    return naturalSort(getImageGenerationModels(availableModels));
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
    onProgress: (params: { currentStep: number, totalSteps: number }) => void,
    signal: AbortSignal | undefined
  }) => {
    const provider = new OllamaProvider({
      endpoint: endpointUrl,
      headers: endpointHttpHeaders
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
      signal
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
    decTask
  }: {
    chatId: string,
    assistantId: string,
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
    storageType: 'opfs' | 'local',
    signal: AbortSignal | undefined,
    getLiveChat: ({ chat }: { chat: Chat }) => Chat | undefined,
    updateChatContent: ({ chatId, updater }: { chatId: string, updater: (current: ChatContent) => ChatContent }) => Promise<void>,
    triggerChatRef: ({ chatId }: { chatId: string }) => void,
    incTask: ({ chatId, type }: { chatId: string, type: 'process' }) => void,
    decTask: ({ chatId, type }: { chatId: string, type: 'process' }) => void
  }) => {
    const target = getLiveChat({ chat: { id: chatId } as Chat });
    if (!target) return;
    const mutableChat = target;
    const assistantNode = findNodeInBranch(mutableChat.root.items, assistantId);
    if (!assistantNode) return;

    // Prioritize the model requested in the sentinel (for regeneration/history)
    // Fallback to the currently selected model or the first available one
    const imageModel = (requestedModel && availableModels.includes(requestedModel))
      ? requestedModel
      : getSelectedImageModel({ chatId, availableModels });

    if (!imageModel) {
      assistantNode.error = 'No suitable image generation model found (starting with x/z-image-turbo:)';
      assistantNode.content = 'Failed to generate image.';
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
        updater: (current) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId })
      });

      const blocks: GeneratedImageBlock[] = [];

      for (let i = 0; i < imageCount; i++) {
        if (signal?.aborted) break;

        // Clear progress for the new image starting to avoid showing stale progress from the previous image
        delete imageProgressMap.value[chatId];

        let activeSeed: number | undefined = undefined;
        if (typeof seed === 'number' && seed >= 0) {
          activeSeed = seed;
        } else if (seed === 'browser_random') {
          activeSeed = crypto.getRandomValues(new Uint32Array(1))[0];
          if (activeSeed !== undefined && activeSeed < 1) activeSeed = 1;
        }

        const blob = await performBase64Generation({
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
            imageProgressMap.value[chatId] = { currentStep, totalSteps };
          },
          signal
        });
        if (!blob) throw new Error('Failed to generate image');

        let finalBlob = blob;
        let extension = '.png';

        if (persistAs && persistAs !== 'original') {
          try {
            finalBlob = await reencodeImage({ blob, format: persistAs });
            extension = `.${persistAs}`;
          } catch (e) {
            const { useGlobalEvents } = await import('../composables/useGlobalEvents');
            const { addErrorEvent } = useGlobalEvents();
            addErrorEvent({
              source: 'useImageGeneration:handleImageGeneration',
              message: `Failed to re-encode image to ${persistAs}, falling back to original`,
              details: e instanceof Error ? e : String(e)
            });
          }
        }

        const displayWidth = width * 0.8;
        const displayHeight = height * 0.8;

        const finalPrompt = activeSeed !== undefined ? `${prompt} (seed: ${activeSeed})` : prompt;

        switch (storageType) {
        case 'opfs': {
          const binaryObjectId = generateId();
          const fileName = sanitizeFilename({
            base: prompt,
            suffix: extension,
            fallback: `generated-${Date.now()}-${i}`
          });
          await storageService.saveFile(finalBlob, binaryObjectId, fileName);

          blocks.push({
            binaryObjectId,
            displayWidth,
            displayHeight,
            prompt: finalPrompt,
            steps,
            seed: activeSeed
          });

          const blocksContent = blocks.map(b => `\`\`\`${IMAGE_BLOCK_LANG}\n${JSON.stringify(b, null, 2)}\n\`\`\``).join('\n\n');
          assistantNode.content = responseMarker + SENTINEL_IMAGE_PENDING + '\n\n' + blocksContent;
          break;
        }
        case 'local': {
          const url = URL.createObjectURL(finalBlob);
          const blockHtml = `<img src="${url}" width="${displayWidth}" height="${displayHeight}" alt="generated image" class="rounded-xl shadow-lg border border-gray-100 dark:border-gray-800 my-2 max-w-full h-auto">`;

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
          updater: (current) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId })
        });
      }
      // Finalize: replace PENDING with PROCESSED
      assistantNode.content = assistantNode.content.replace(SENTINEL_IMAGE_PENDING, signal?.aborted ? '' : SENTINEL_IMAGE_PROCESSED);
    } catch (e) {
      assistantNode.error = (e as Error).message;
      // Cleanup sentinel on error
      assistantNode.content = assistantNode.content.replace(SENTINEL_IMAGE_PENDING, '');
      if (assistantNode.content.trim() === '') {
        assistantNode.content = 'Failed to generate image.';
      }
    } finally {
      delete imageProgressMap.value[chatId];
      decTask({ chatId, type: 'process' });
      await updateChatContent({
        chatId: mutableChat.id,
        updater: (current) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId })
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
    sendMessage
  }: {
    prompt: string,
    width: number,
    height: number,
    count: number,
    steps: number | undefined,
    seed: number | 'browser_random' | undefined,
    persistAs: ImageRequestParams['persistAs'],
    chatId: string,
    attachments: Attachment[],
    availableModels: string[],
    sendMessage: ({ content, parentId, attachments }: { content: string, parentId: string | undefined, attachments: Attachment[] }) => Promise<boolean>
  }): Promise<boolean> => {
    const prevMode = !!imageModeMap.value[chatId];
    const prevRes = imageResolutionMap.value[chatId];
    const prevCount = imageCountMap.value[chatId];
    const prevSteps = imageStepsMap.value[chatId];
    const prevSeed = imageSeedMap.value[chatId];
    const prevPersistAs = imagePersistAsMap.value[chatId];
    const model = getSelectedImageModel({ chatId, availableModels });

    imageModeMap.value[chatId] = true;
    imageResolutionMap.value[chatId] = { width, height };
    imageCountMap.value[chatId] = count;
    imageStepsMap.value[chatId] = steps;
    imageSeedMap.value[chatId] = seed;
    imagePersistAsMap.value[chatId] = persistAs;

    try {
      // Sentinel for history needs a string or number.
      const seedParam = seed === 'browser_random' ? 'browser_random' : seed;

      const content = model
        ? createImageRequestMarker({ width, height, model, count, persistAs, steps, seed: seedParam }) + prompt
        : prompt;
      return await sendMessage({ content, parentId: undefined, attachments });
    } finally {
      imageModeMap.value[chatId] = prevMode;
      if (prevRes) imageResolutionMap.value[chatId] = prevRes;
      if (prevCount !== undefined) imageCountMap.value[chatId] = prevCount;
      imageStepsMap.value[chatId] = prevSteps;
      imageSeedMap.value[chatId] = prevSeed;
      if (prevPersistAs !== undefined) imagePersistAsMap.value[chatId] = prevPersistAs;
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
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}