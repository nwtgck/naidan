import { ref } from 'vue';
import { OllamaProvider } from '../services/llm';
import { storageService } from '../services/storage';
import { 
  getImageGenerationModels, 
  SENTINEL_IMAGE_PENDING, 
  SENTINEL_IMAGE_PROCESSED,
  createImageRequestMarker,
  IMAGE_BLOCK_LANG,
  type GeneratedImageBlock
} from '../utils/image-generation';
import { naturalSort, sanitizeFilename } from '../utils/string';
import type { Chat, ChatContent, Attachment } from '../models/types';
import { findNodeInBranch } from '../utils/chat-tree';

// Shared state across all instances to maintain consistency
const imageModeMap = ref<Record<string, boolean>>({});
const imageResolutionMap = ref<Record<string, { width: number, height: number }>>({});
const imageModelOverrideMap = ref<Record<string, string>>({});

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

  const performBase64Generation = async ({ prompt, model, width, height, images, endpointUrl, endpointHttpHeaders, signal }: {
    prompt: string,
    model: string,
    width: number,
    height: number,
    images: { blob: Blob }[],
    endpointUrl: string,
    endpointHttpHeaders: [string, string][] | undefined,
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
      images,
      signal
    });
  };

  const handleImageGeneration = async ({ 
    chatId, 
    assistantId, 
    prompt, 
    width, 
    height,
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
      assistantNode.content = SENTINEL_IMAGE_PENDING;
      // Ensure the assistant node uses the actual model ID for metadata
      assistantNode.modelId = imageModel;
      triggerChatRef({ chatId });

      const blob = await performBase64Generation({ 
        prompt, 
        model: imageModel, 
        width, 
        height, 
        images,
        endpointUrl,
        endpointHttpHeaders,
        signal
      });
      if (!blob) throw new Error('Failed to generate image');

      const displayWidth = width * 0.8;
      const displayHeight = height * 0.8;

      switch (storageType) {
      case 'opfs': {
        const binaryObjectId = crypto.randomUUID();
        const fileName = sanitizeFilename({
          base: prompt,
          suffix: '.png',
          fallback: `generated-${Date.now()}`
        });
        await storageService.saveFile(blob, binaryObjectId, fileName);
        
        const block: GeneratedImageBlock = { 
          binaryObjectId, 
          displayWidth, 
          displayHeight,
          prompt
        };
        
        assistantNode.content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n${JSON.stringify(block, null, 2)}\n\`\`\``;
        break;
      }
      case 'local': {
        const url = URL.createObjectURL(blob);
        assistantNode.content = `${SENTINEL_IMAGE_PROCESSED}<img src="${url}" width="${displayWidth}" height="${displayHeight}" alt="generated image" class="rounded-xl shadow-lg border border-gray-100 dark:border-gray-800 my-2 max-w-full h-auto">`;
        break;
      }
      default: {
        const _ex: never = storageType;
        throw new Error(`Unhandled storage type: ${_ex}`);
      }
      }
    } catch (e) {
      assistantNode.error = (e as Error).message;
      assistantNode.content = 'Failed to generate image.';
    } finally {
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
    chatId, 
    attachments,
    availableModels,
    sendMessage 
  }: {
    prompt: string,
    width: number,
    height: number,
    chatId: string,
    attachments: Attachment[],
    availableModels: string[],
    sendMessage: ({ content, parentId, attachments }: { content: string, parentId: string | undefined, attachments: Attachment[] }) => Promise<boolean>
  }): Promise<boolean> => {
    const prevMode = !!imageModeMap.value[chatId];
    const prevRes = imageResolutionMap.value[chatId];
    const model = getSelectedImageModel({ chatId, availableModels });
    
    imageModeMap.value[chatId] = true;
    imageResolutionMap.value[chatId] = { width, height };

    try {
      // If we have a specific model, we can pre-create the marker to embed it
      const content = model 
        ? createImageRequestMarker({ width, height, model }) + prompt
        : prompt;
      return await sendMessage({ content, parentId: undefined, attachments });
    } finally {
      imageModeMap.value[chatId] = prevMode;
      if (prevRes) imageResolutionMap.value[chatId] = prevRes;
    }
  };

  return {
    imageModeMap,
    imageResolutionMap,
    imageModelOverrideMap,
    isImageMode,
    toggleImageMode,
    getResolution,
    updateResolution,
    setImageModel,
    getSelectedImageModel,
    getSortedImageModels,
    performBase64Generation,
    handleImageGeneration,
    sendImageRequest
  };
}