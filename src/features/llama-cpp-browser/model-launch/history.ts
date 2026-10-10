import type { RouterHistory } from 'vue-router';
import { z } from 'zod';
import { modelSourceRevisionSchema } from '@/01-models/llama-cpp-browser-model-launch';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { readModelLaunchReference } from './reference';
import { generateId } from '@/01-models/id';
import { idToRaw, toChatId, toChatGroupId, type ChatId, type ChatGroupId } from '@/01-models/ids';

const reservationSchema = z.object({
  version: z.literal(1),
  location: z.string().min(1).max(16384),
  chatId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  chatGroupId: z.string().regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export const modelLaunchHistoryKey = '_internalNaidanLlamaCppBrowserModelLaunch';

/** Preserve Vue Router's history bookkeeping; add no internal URL protocol. */
export function reserveModelLaunchHistory({ history, location, fallback }: { fallback: { chatId: ChatId, newChatGroupId: ChatGroupId } | undefined, history: Pick<RouterHistory, 'state' | 'replace' | 'location'>, location: string }): { chatId: ChatId, newChatGroupId: ChatGroupId } {
  const state = history.state;
  const previous = reservationSchema.safeParse(state[modelLaunchHistoryKey]);
  if (previous.success && previous.data.location === location) return {
    chatId: toChatId({ raw: previous.data.chatId }),
    newChatGroupId: toChatGroupId({ raw: previous.data.chatGroupId }),
  };
  const chatId = fallback?.chatId ?? generateId<ChatId>();
  const newChatGroupId = fallback?.newChatGroupId ?? generateId<ChatGroupId>();
  const reservation = reservationSchema.parse({ version: 1, location, chatId: idToRaw({ id: chatId }), chatGroupId: idToRaw({ id: newChatGroupId }) });
  history.replace(history.location, { ...state, [modelLaunchHistoryKey]: reservation });
  return { chatId, newChatGroupId };
}

const viewSchema = z.object({
  version: z.literal(1),
  chatId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  input: z.string().min(1).max(4096),
  modelId: z.string().min(1).max(512),
  revision: modelSourceRevisionSchema,
}).strict();
export const modelLaunchViewHistoryKey = '_internalNaidanLlamaCppBrowserModelLaunchView';
export type ModelLaunchView = z.infer<typeof viewSchema>;

/** Navigation context only: no credentials, payload bytes, or source plan. */
export function modelLaunchViewState({ chatId, input, modelId, revision }: { chatId: ChatId, input: string, modelId: string, revision: string }): ModelLaunchView {
  return viewSchema.parse({ version: 1, chatId: idToRaw({ id: chatId }), input, modelId, revision });
}

export function readModelLaunchView({ state, chatId, modelId }: { state: unknown, chatId: ChatId, modelId: string | undefined }): ModelLaunchView | undefined {
  const parsed = viewSchema.safeParse(state);
  if (!parsed.success || parsed.data.chatId !== idToRaw({ id: chatId }) || parsed.data.modelId !== modelId) return undefined;
  const reference = readModelLaunchReference({ modelId });
  if (reference === undefined) return undefined;
  try {
    // History state is untrusted input, not authority to replace saved settings.
    if (parseRepository({ input: parsed.data.input }).repository !== reference.repository) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

export const TEST_ONLY = {
};
