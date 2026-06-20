import type { Attachment, Chat } from '@/models/types';
import type { ChatId, MessageId } from '@/models/ids';
import { UNKNOWN_STEPS } from '@/services/lm/types';
import { useImageGeneration } from '@/composables/useImageGeneration';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import type { ImageRequestParams } from '@/utils/image-generation';

export async function sendImageRequestForChat({
  chatId,
  prompt,
  width,
  height,
  count,
  steps,
  seed,
  persistAs,
  attachments,
  availableModels,
  sendMessage,
}: {
  chatId: ChatId;
  prompt: string;
  width: number;
  height: number;
  count: number;
  steps: number | undefined;
  seed: number | 'browser_random' | undefined;
  persistAs: ImageRequestParams['persistAs'];
  attachments: Attachment[];
  availableModels: string[];
  sendMessage: ({
    content,
    parentId,
    attachments,
  }: {
    content: string;
    parentId: MessageId | undefined;
    attachments: Attachment[];
  }) => Promise<boolean>;
}): Promise<boolean> {
  const imageGeneration = useImageGeneration();
  return await imageGeneration.sendImageRequest({
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
  });
}

export async function handleImageGenerationForChat({
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
  chatId: ChatId;
  assistantId: MessageId;
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
    chatId: ChatId;
    updater: ({ current }: { current: import('@/models/types').ChatContent }) => import('@/models/types').ChatContent;
  }) => Promise<void>;
  triggerChatRef: ({ chatId }: { chatId: ChatId }) => void;
  incTask: ({ chatId, type }: { chatId: ChatId; type: 'process' }) => void;
  decTask: ({ chatId, type }: { chatId: ChatId; type: 'process' }) => void;
}): Promise<void> {
  const imageGeneration = useImageGeneration();
  await imageGeneration.handleImageGeneration({
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
  });
}

export async function generateImageForChat({
  prompt,
  model,
  width,
  height,
  steps,
  seed,
  images,
  chat,
  chatGroups,
  settings,
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
  chatGroups: import('@/models/types').ChatGroup[];
  settings: import('@/models/types').Settings;
  signal: AbortSignal | undefined;
}): Promise<{ image: Blob; totalSteps: number | typeof UNKNOWN_STEPS }> {
  const imageGeneration = useImageGeneration();
  const resolved = resolveChatSettings({
    chat,
    groups: chatGroups,
    globalSettings: settings,
  });
  if (resolved.endpointUrl === undefined) {
    throw new Error('Image generation requires an endpoint URL');
  }

  return await imageGeneration.performBase64Generation({
    prompt,
    model,
    width,
    height,
    steps,
    seed,
    images,
    endpointUrl: resolved.endpointUrl,
    endpointHttpHeaders: resolved.endpointHttpHeaders ? [...resolved.endpointHttpHeaders] : undefined,
    onProgress: ({ currentStep: _currentStep, totalSteps: _totalSteps }) => {},
    signal,
  });
}
