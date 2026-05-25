import type { Attachment, Chat } from '@/models/types';
import { UNKNOWN_STEPS } from '@/services/lm/types';
import type { ImageRequestParams } from '@/utils/image-generation';

type ResolvedImageSettings = {
  endpointUrl: string | undefined;
  endpointHttpHeaders: [string, string][] | undefined;
};

export type ChatImageService = {
  handleImageGeneration({
    chatId,
    assistantId,
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs,
    images,
    model,
    signal,
  }: {
    chatId: string;
    assistantId: string;
    prompt: string;
    width: number;
    height: number;
    count: number;
    steps: number | undefined;
    seed: number | 'browser_random' | undefined;
    persistAs: ImageRequestParams['persistAs'] | undefined;
    images: { blob: Blob }[];
    model: string | undefined;
    signal: AbortSignal | undefined;
  }): Promise<void>;

  generateImage({
    prompt,
    model,
    width,
    height,
    steps,
    seed,
    images,
    chat,
    signal,
  }: {
    prompt: string;
    model: string;
    width: number;
    height: number;
    steps: number | undefined;
    seed: number | undefined;
    images: { blob: Blob }[];
    chat: Chat;
    signal: AbortSignal | undefined;
  }): Promise<{ image: Blob; totalSteps: number | typeof UNKNOWN_STEPS }>;

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
};

export function createChatImageService({
  getCurrentChat,
  getLiveChat,
  getAvailableModels,
  getStorageType,
  resolveSettings,
  performGeneration,
  handleImageGenerationImpl,
  sendImageRequestImpl,
  updateChatContent,
  triggerCurrentChat,
  startProcessing,
  finishProcessing,
  sendMessage,
}: {
  getCurrentChat: () => Chat | null;
  getLiveChat: ({ chat }: { chat: Chat }) => Chat | undefined;
  getAvailableModels: () => string[];
  getStorageType: () => 'opfs' | 'local' | 'memory';
  resolveSettings: ({ chat }: { chat: Chat }) => ResolvedImageSettings;
  performGeneration: ({
    prompt,
    model,
    width,
    height,
    steps,
    seed,
    images,
    endpointUrl,
    endpointHttpHeaders,
    onProgress,
    signal,
  }: {
    prompt: string;
    model: string;
    width: number;
    height: number;
    steps: number | undefined;
    seed: number | undefined;
    images: { blob: Blob }[];
    endpointUrl: string;
    endpointHttpHeaders: [string, string][] | undefined;
    onProgress: ({ currentStep, totalSteps }: { currentStep: number; totalSteps: number }) => void;
    signal: AbortSignal | undefined;
  }) => Promise<{ image: Blob; totalSteps: number | typeof UNKNOWN_STEPS }>;
  handleImageGenerationImpl: ({
    chatId,
    assistantId,
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs,
    images,
    model,
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
    chatId: string;
    assistantId: string;
    prompt: string;
    width: number;
    height: number;
    count: number;
    steps: number | undefined;
    seed: number | 'browser_random' | undefined;
    persistAs: ImageRequestParams['persistAs'] | undefined;
    images: { blob: Blob }[];
    model: string | undefined;
    availableModels: string[];
    endpointUrl: string;
    endpointHttpHeaders: [string, string][] | undefined;
    storageType: 'opfs' | 'local' | 'memory';
    signal: AbortSignal | undefined;
    getLiveChat: ({ chat }: { chat: Chat }) => Chat | undefined;
    updateChatContent: ({
      chatId,
      updater,
    }: {
      chatId: string;
      updater: (current: import('@/models/types').ChatContent) => import('@/models/types').ChatContent;
    }) => Promise<void>;
    triggerChatRef: ({ chatId }: { chatId: string }) => void;
    incTask: ({ chatId, type }: { chatId: string; type: 'process' }) => void;
    decTask: ({ chatId, type }: { chatId: string; type: 'process' }) => void;
  }) => Promise<void>;
  sendImageRequestImpl: ({
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
    prompt: string;
    width: number;
    height: number;
    count: number;
    steps: number | undefined;
    seed: number | 'browser_random' | undefined;
    persistAs: ImageRequestParams['persistAs'];
    chatId: string;
    attachments: Attachment[];
    availableModels: string[];
    sendMessage: ({
      content,
      parentId,
      attachments,
    }: {
      content: string;
      parentId: string | undefined;
      attachments: Attachment[];
    }) => Promise<boolean>;
  }) => Promise<boolean>;
  updateChatContent: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: import('@/models/types').ChatContent | null) => import('@/models/types').ChatContent;
  }) => Promise<void>;
  triggerCurrentChat: ({ chatId }: { chatId: string }) => void;
  startProcessing: ({ chatId }: { chatId: string }) => void;
  finishProcessing: ({ chatId }: { chatId: string }) => void;
  sendMessage: ({
    content,
    parentId,
    attachments,
  }: {
    content: string;
    parentId: string | null;
    attachments: Attachment[];
  }) => Promise<boolean>;
}): ChatImageService {
  async function handleImageGeneration({
    chatId,
    assistantId,
    prompt,
    width,
    height,
    count,
    steps,
    seed,
    persistAs,
    images,
    model,
    signal,
  }: {
    chatId: string;
    assistantId: string;
    prompt: string;
    width: number;
    height: number;
    count: number;
    steps: number | undefined;
    seed: number | 'browser_random' | undefined;
    persistAs: ImageRequestParams['persistAs'] | undefined;
    images: { blob: Blob }[];
    model: string | undefined;
    signal: AbortSignal | undefined;
  }) {
    const target = getLiveChat({ chat: { id: chatId } as Chat });
    if (!target) return;
    const resolved = resolveSettings({ chat: target });
    if (!resolved.endpointUrl) {
      throw new Error('Image generation requires an endpoint URL');
    }

    await handleImageGenerationImpl({
      chatId,
      assistantId,
      prompt,
      width,
      height,
      count,
      steps,
      seed,
      persistAs,
      images,
      model,
      availableModels: getAvailableModels(),
      endpointUrl: resolved.endpointUrl,
      endpointHttpHeaders: resolved.endpointHttpHeaders,
      storageType: getStorageType(),
      signal,
      getLiveChat,
      updateChatContent: ({ chatId, updater }) => updateChatContent({
        id: chatId,
        updater: (current) => {
          if (!current) throw new Error('Chat content not found');
          return updater(current);
        },
      }),
      triggerChatRef: triggerCurrentChat,
      incTask: ({ chatId, type }) => {
        if (type === 'process') {
          startProcessing({ chatId });
        }
      },
      decTask: ({ chatId, type }) => {
        if (type === 'process') {
          finishProcessing({ chatId });
        }
      },
    });
  }

  async function generateImage({
    prompt,
    model,
    width,
    height,
    steps,
    seed,
    images,
    chat,
    signal,
  }: {
    prompt: string;
    model: string;
    width: number;
    height: number;
    steps: number | undefined;
    seed: number | undefined;
    images: { blob: Blob }[];
    chat: Chat;
    signal: AbortSignal | undefined;
  }) {
    const resolved = resolveSettings({ chat });
    if (!resolved.endpointUrl) {
      throw new Error('Image generation requires an endpoint URL');
    }

    return await performGeneration({
      prompt,
      model,
      width,
      height,
      steps,
      seed,
      images,
      endpointUrl: resolved.endpointUrl,
      endpointHttpHeaders: resolved.endpointHttpHeaders,
      onProgress: () => {},
      signal,
    });
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
  }) {
    const target = getCurrentChat();
    if (!target) return false;

    return await sendImageRequestImpl({
      prompt,
      width,
      height,
      count,
      steps,
      seed,
      persistAs,
      chatId: target.id,
      attachments,
      availableModels: getAvailableModels(),
      sendMessage: ({ content, parentId, attachments }) => sendMessage({
        content,
        parentId: parentId || null,
        attachments,
      }),
    });
  }

  return {
    handleImageGeneration,
    generateImage,
    sendImageRequest,
  };
}
