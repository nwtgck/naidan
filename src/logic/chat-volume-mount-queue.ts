import type { ChatId } from '@/01-models/ids';

const pendingMounts = new Map<ChatId, Promise<void>>();

/** Serialize attachment path assignment, without holding up file copying. */
export async function queueChatVolumeMount({ chatId, operation }: { chatId: ChatId, operation(): Promise<void> }): Promise<void> {
  const previous = pendingMounts.get(chatId) ?? Promise.resolve();
  const current = previous.then(operation);
  const settled = current.then(() => {}, () => {});
  pendingMounts.set(chatId, settled);
  try {
    await current;
  } finally {
    if (pendingMounts.get(chatId) === settled) {
      pendingMounts.delete(chatId);
    }
  }
}

export const TEST_ONLY = {
};
