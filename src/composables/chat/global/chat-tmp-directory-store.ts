import { reactive } from 'vue';
import { idToRaw } from '@/01-models/ids';
import type { ChatId } from '@/01-models/ids';
import { getOPFSTmpManager } from '@/logic/opfs-tmp-manager';
import type { StorageVolumeAccess } from '@/00-storage/service/volume-access';

export type ChatTmpDirectoryEntry = {
  access: StorageVolumeAccess,
  mountPath: '/tmp',
};

export const chatTmpDirectories = reactive(new Map<ChatId, ChatTmpDirectoryEntry>());

export async function ensureChatTmpDirectory({
  chatId,
}: {
  chatId: ChatId,
}): Promise<ChatTmpDirectoryEntry> {
  const existing = chatTmpDirectories.get(chatId);
  if (existing !== undefined) {
    return existing;
  }

  const access = await getOPFSTmpManager().createTmpDirectory({ prefix: idToRaw({ id: chatId }) });
  const created: ChatTmpDirectoryEntry = {
    access,
    mountPath: '/tmp',
  };
  chatTmpDirectories.set(chatId, created);
  return created;
}

export function getChatTmpDirectory({
  chatId,
}: {
  chatId: ChatId | undefined,
}): ChatTmpDirectoryEntry | undefined {
  if (chatId === undefined) {
    return undefined;
  }

  return chatTmpDirectories.get(chatId);
}

export function clearChatTmpDirectories(): void {
  chatTmpDirectories.clear();
}

export function deleteChatTmpDirectory({
  chatId,
}: {
  chatId: ChatId,
}): void {
  chatTmpDirectories.delete(chatId);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
