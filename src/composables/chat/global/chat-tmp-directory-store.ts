import { reactive } from 'vue';
import { getOPFSTmpManager } from '@/services/opfs-tmp-manager';

export type ChatTmpDirectoryEntry = {
  handle: FileSystemDirectoryHandle;
  mountPath: '/tmp';
};

export const chatTmpDirectories = reactive(new Map<string, ChatTmpDirectoryEntry>());

export async function ensureChatTmpDirectory({
  chatId,
}: {
  chatId: string;
}): Promise<ChatTmpDirectoryEntry> {
  const existing = chatTmpDirectories.get(chatId);
  if (existing !== undefined) {
    return existing;
  }

  const handle = await getOPFSTmpManager().createTmpDirectory({ prefix: chatId });
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
  chatId: string | undefined;
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
  chatId: string;
}): void {
  chatTmpDirectories.delete(chatId);
}
