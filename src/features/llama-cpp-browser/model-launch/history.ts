import type { RouterHistory } from 'vue-router';
import { z } from 'zod';
import { generateId } from '@/01-models/id';
import { idToRaw, toChatId, toChatGroupId, type ChatId, type ChatGroupId } from '@/01-models/ids';

const reservationSchema = z.object({
  version: z.literal(1),
  location: z.string().min(1).max(16384),
  chatId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  chatGroupId: z.string().regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export const modelLaunchHistoryKey = '_internalNaidanLlamaCppBrowserModelLaunch';

export function readModelLaunchHistoryReservation({ history, location }: { history: Pick<RouterHistory, 'state'>, location: string }): { chatId: ChatId, newChatGroupId: ChatGroupId } | undefined {
  const previous = reservationSchema.safeParse(history.state[modelLaunchHistoryKey]);
  return previous.success && previous.data.location === location ? {
    chatId: toChatId({ raw: previous.data.chatId }),
    newChatGroupId: toChatGroupId({ raw: previous.data.chatGroupId }),
  } : undefined;
}

/** Preserve Vue Router's history bookkeeping; add no internal URL protocol. */
export function reserveModelLaunchHistory({ history, location, fallback }: { fallback: { chatId: ChatId, newChatGroupId: ChatGroupId } | undefined, history: Pick<RouterHistory, 'state' | 'replace' | 'location'>, location: string }): { chatId: ChatId, newChatGroupId: ChatGroupId } {
  const state = history.state;
  const previous = reservationSchema.safeParse(state[modelLaunchHistoryKey]);
  if (previous.success && previous.data.location === location) {
    return {
      chatId: toChatId({ raw: previous.data.chatId }),
      newChatGroupId: toChatGroupId({ raw: previous.data.chatGroupId }),
    };
  }
  const chatId = fallback?.chatId ?? generateId<ChatId>();
  const newChatGroupId = fallback?.newChatGroupId ?? generateId<ChatGroupId>();
  const reservation = reservationSchema.parse({ version: 1, location, chatId: idToRaw({ id: chatId }), chatGroupId: idToRaw({ id: newChatGroupId }) });
  history.replace(history.location, { ...state, [modelLaunchHistoryKey]: reservation });
  return { chatId, newChatGroupId };
}

export const TEST_ONLY = {
};
