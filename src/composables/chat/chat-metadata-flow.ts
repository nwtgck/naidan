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
