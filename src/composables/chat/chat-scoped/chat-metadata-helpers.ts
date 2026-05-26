import type { LmParameters, Reasoning } from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import {
  getChatTargetByOptionalId,
  loadData,
  triggerCurrentChat,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';

export async function renameChatById({
  chatId,
  title,
}: {
  chatId: string;
  title: string;
}): Promise<void> {
  const liveChat = getChatTargetByOptionalId({ chatId });
  if (liveChat !== null) {
    liveChat.title = title;
    liveChat.updatedAt = Date.now();
    triggerCurrentChat({ chatId });
  }

  await updateChatMeta({
    id: chatId,
    updater: (current) => {
      if (current === null) {
        throw new Error('Chat not found');
      }

      return {
        ...current,
        title,
        updatedAt: Date.now(),
      };
    },
  });
  await loadData({});
}

export async function toggleDebugForChatId({
  chatId,
}: {
  chatId: string;
}): Promise<void> {
  const targetChat = getChatTargetByOptionalId({ chatId });
  if (targetChat === null) {
    return;
  }

  const debugEnabled = !targetChat.debugEnabled;
  targetChat.debugEnabled = debugEnabled;
  targetChat.updatedAt = Date.now();
  triggerCurrentChat({ chatId });

  await updateChatMeta({
    id: chatId,
    updater: (current) => {
      if (current === null) {
        throw new Error('Chat not found');
      }

      return {
        ...current,
        debugEnabled,
        updatedAt: Date.now(),
      };
    },
  });
}

export async function updateChatModelById({
  chatId,
  modelId,
}: {
  chatId: string;
  modelId: string | undefined;
}): Promise<void> {
  const liveChat = getChatTargetByOptionalId({ chatId });
  if (liveChat !== null) {
    liveChat.modelId = modelId;
    liveChat.updatedAt = Date.now();
    triggerCurrentChat({ chatId });
  }

  await updateChatMeta({
    id: chatId,
    updater: (current) => {
      if (current === null) {
        throw new Error('Chat not found');
      }

      return {
        ...current,
        modelId,
        updatedAt: Date.now(),
      };
    },
  });
}

export async function updateChatGroupOverrideById({
  chatId,
  groupId,
}: {
  chatId: string;
  groupId: string | null;
}): Promise<void> {
  const liveChat = getChatTargetByOptionalId({ chatId });
  if (liveChat !== null) {
    liveChat.groupId = groupId;
    liveChat.updatedAt = Date.now();
    triggerCurrentChat({ chatId });
  }

  await updateChatMeta({
    id: chatId,
    updater: (current) => {
      if (current === null) {
        throw new Error('Chat not found');
      }

      return {
        ...current,
        groupId,
        updatedAt: Date.now(),
      };
    },
  });
  await loadData({});
}

export async function updateChatSettingsById({
  chatId,
  updates,
}: {
  chatId: string;
  updates: Partial<Pick<import('@/models/types').Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
}): Promise<void> {
  const liveChat = getChatTargetByOptionalId({ chatId });
  if (liveChat !== null) {
    Object.assign(liveChat, updates);
    liveChat.updatedAt = Date.now();
    triggerCurrentChat({ chatId });
  }

  await updateChatMeta({
    id: chatId,
    updater: (current) => {
      if (current === null) {
        throw new Error('Chat not found');
      }

      type _NoFlatEndpoint = Omit<import('@/models/types').Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders'> & {
        endpointType?: never;
        endpointUrl?: never;
        endpointHttpHeaders?: never;
      };

      const {
        endpointType: currentEndpointType,
        endpointUrl: currentEndpointUrl,
        endpointHttpHeaders: currentEndpointHttpHeaders,
        ...currentRest
      } = current;
      const {
        endpointType,
        endpointUrl,
        endpointHttpHeaders,
        ...rest
      } = updates;
      const resolvedEndpointType = endpointType !== undefined ? endpointType : currentEndpointType;

      const metaUpdates: Partial<_NoFlatEndpoint> = {
        ...rest,
        ...(resolvedEndpointType !== undefined && {
          endpoint: {
            type: resolvedEndpointType,
            url: endpointUrl !== undefined ? endpointUrl : currentEndpointUrl,
            httpHeaders: endpointHttpHeaders !== undefined ? endpointHttpHeaders : currentEndpointHttpHeaders,
          },
        }),
      };
      return { ...currentRest, ...metaUpdates, updatedAt: Date.now() };
    },
  });
}

export function getReasoningEffortForChatId({
  chatId,
}: {
  chatId: string;
}): Reasoning['effort'] | undefined {
  return getChatTargetByOptionalId({ chatId })?.lmParameters?.reasoning?.effort;
}

export async function updateReasoningEffortForChatId({
  chatId,
  effort,
}: {
  chatId: string;
  effort: Reasoning['effort'] | undefined;
}): Promise<void> {
  const liveChat = getChatTargetByOptionalId({ chatId });
  if (liveChat === null) {
    return;
  }

  const lmParameters: LmParameters = {
    ...(liveChat.lmParameters || EMPTY_LM_PARAMETERS),
    reasoning: { effort },
  };

  liveChat.lmParameters = lmParameters;
  liveChat.updatedAt = Date.now();
  triggerCurrentChat({ chatId });

  await updateChatMeta({
    id: chatId,
    updater: (current) => {
      if (current === null) {
        throw new Error('Chat not found');
      }

      return {
        ...current,
        lmParameters,
        updatedAt: Date.now(),
      };
    },
  });
}
