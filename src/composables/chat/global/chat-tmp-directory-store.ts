import { reactive } from 'vue';
import { idToRaw } from '@/models/ids';
import type { ChatId } from '@/models/ids';
import { getOPFSTmpManager } from '@/services/opfs-tmp-manager';

export type ChatTmpDirectoryEntry = {
  handle: FileSystemDirectoryHandle;
  mountPath: '/tmp';
};

export const chatTmpDirectories = reactive(new Map<ChatId, ChatTmpDirectoryEntry>());

export async function ensureChatTmpDirectory({
  chatId,
}: {
  chatId: ChatId;
}): Promise<ChatTmpDirectoryEntry> {
  const existing = chatTmpDirectories.get(chatId);
  if (existing !== undefined) {
    return existing;
  }

  const handle = await getOPFSTmpManager().createTmpDirectory({ prefix: idToRaw({ id: chatId }) });
  const created: ChatTmpDirectoryEntry = {
    handle,
    mountPath: '/tmp',
  };
  chatTmpDirectories.set(chatId, created);
  return created;
}

export function getChatTmpDirectory({
  chatId,
}: {
  chatId: ChatId | undefined;
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
  chatId: ChatId;
}): void {
  chatTmpDirectories.delete(chatId);
}
