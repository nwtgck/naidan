import { reactive } from 'vue';

export type ChatTmpDirectoryEntry = {
  handle: FileSystemDirectoryHandle;
  mountPath: '/tmp';
};

export type ChatTmpDirectoryService = {
  ensureChatTmpDirectory({
    chatId,
  }: {
    chatId: string;
  }): Promise<ChatTmpDirectoryEntry>;

  getChatTmpDirectory({
    chatId,
  }: {
    chatId: string | undefined;
  }): ChatTmpDirectoryEntry | undefined;

  clearChatTmpDirectories(_args: Record<never, never>): void;

  deleteChatTmpDirectory({
    chatId,
  }: {
    chatId: string;
  }): void;

  TEST_ONLY: {
    chatTmpDirectories: Map<string, ChatTmpDirectoryEntry>;
  };
};

export function createChatTmpDirectoryService({
  createTmpMountDirectory,
}: {
  createTmpMountDirectory: ({ chatId }: { chatId: string }) => Promise<FileSystemDirectoryHandle>;
}): ChatTmpDirectoryService {
  const chatTmpDirectories = reactive(new Map<string, ChatTmpDirectoryEntry>());

  async function ensureChatTmpDirectory({
    chatId,
  }: {
    chatId: string;
  }) {
    const existing = chatTmpDirectories.get(chatId);
    if (existing) return existing;

    const handle = await createTmpMountDirectory({ chatId });
    const created: ChatTmpDirectoryEntry = {
      handle,
      mountPath: '/tmp',
    };
    chatTmpDirectories.set(chatId, created);
    return created;
  }

  function getChatTmpDirectory({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (!chatId) return undefined;
    return chatTmpDirectories.get(chatId);
  }

  function clearChatTmpDirectories(_args: Record<never, never>) {
    chatTmpDirectories.clear();
  }

  function deleteChatTmpDirectory({
    chatId,
  }: {
    chatId: string;
  }) {
    chatTmpDirectories.delete(chatId);
  }

  return {
    ensureChatTmpDirectory,
    getChatTmpDirectory,
    clearChatTmpDirectories,
    deleteChatTmpDirectory,
    TEST_ONLY: {
      chatTmpDirectories,
    },
  };
}
